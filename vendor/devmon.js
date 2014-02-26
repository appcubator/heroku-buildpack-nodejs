#!/usr/bin/env node

var fs = require('fs');
var child_process = require('child_process');
var http = require('http');
var formidable = require('formidable');

var forever = require('forever-monitor');

var DEBUG = true;

var devmon_log = function(s) {
    console.log('[Appcubator] ' + s);
};
            String.prototype.endsWith = function(suffix) {
                    return this.indexOf(suffix, this.length - suffix.length) !== -1;
            };

var spawnApp = function (command) {
    /* command should be an array of args */
    var child = forever.start(command, {watch:true, watchDirectory:'.'});

    child.on('start', function () {
        devmon_log('App has started');
    }).on('exit', function () {
        devmon_log('App has quit');
    }).on('restart', function () {
        devmon_log('App has restarted');
    });
};

var spawnNodeInspector = function() {
    /* note that this will only work if the app has node --debug. */
    var child = forever.start(['node-inspector'], {});
    child.on('start', function () {
        devmon_log('Node-inspector has started');
    }).on('exit', function () {
        devmon_log('Node-inspector has quit');
    }).on('restart', function () {
        devmon_log('Node-inspector has restarted');
    });
};

var updatingCode = false;
var updateCode = function (tarpath, callback) {
    updatingCode = true;
    child_process.exec('tar -xvf '+tarpath, function(err, stdout, stderr) {
        updatingCode = false;
        if (err) devmon_log(err);
        else {
            devmon_log('Code updated. Tar output:');
            devmon_log(stdout);
            devmon_log(stderr);
            callback();
        }
    });
};


var httpProxy = function (LOCAL_PORT, REMOTE_ADDR, REMOTE_PORT) {
    /*
     * Modified from:
     *   A simple proxy server written in node.js.
     *   Peteris Krumins (peter@catonmat.net)
     *   http://www.catonmat.net/http-proxy-in-nodejs/
     *
     */
    var s = http.createServer(function(request, response) {
        var ip = request.connection.remoteAddress;
        devmon_log(ip + ": " + request.method + " " + request.url);

        if (request.headers.referer && request.headers.referer.endsWith('/dev/node-inspector/')) {
            if (request.url.indexOf('/dev/node-inspector') !== 0)
            request.url = '/dev/node-inspector' + request.url;
        }

        /* [ ROUTE ] update code */
        if (!updatingCode && request.url.indexOf('__update_code__') != -1) {
            var form = new formidable.IncomingForm();

            form.parse(request, function(err, fields, files) {
                // Note: it will write this relative to the current working directory which should be appdir
                if (err) {
                    devmon_log(err);
                } else {
                    devmon_log('Written out to '+files.code.path);
                    updateCode(files.code.path, function(){
                        response.writeHead(200, {'content-type': 'text/plain'});
                        response.end('OK');
                    });
                }
            });
        /* [ ROUTE ] node-inspector */
        } else if (request.url.indexOf('/dev/node-inspector/') != -1) {
            var newUrl;
            if (request.url.endsWith('/dev/node-inspector/')) {
                newUrl = request.url.replace('/dev/node-inspector/', '/debug?port=5858');
            } else {
                newUrl = request.url.replace('/dev/node-inspector/', '/');
            }
            console.log(newUrl);
            var proxy_request = http.request({method:request.method,
                                              hostname: '127.0.0.1',
                                              port: 8080,
                                              path: newUrl,
                                              headers: request.headers});
            proxy_request.addListener('response', function(proxy_response) {
                proxy_response.addListener('data', function(chunk) {
                    response.write(chunk, 'binary');
                });
                proxy_response.addListener('end', function() {
                    response.end();
                });
                response.writeHead(proxy_response.statusCode, proxy_response.headers);
            });
            request.addListener('data', function(chunk) {
                proxy_request.write(chunk, 'binary');
            });
            proxy_request.addListener('error', function(err) {
                if (err.code == 'ECONNREFUSED') {
                    response.writeHead(502, {'content-type': 'text/plain'});
                    // TODO attempt to bring it back up
                    response.end('node-inspector is down.'); 
                }
            });
            request.addListener('end', function() {
                proxy_request.end();
            });
        /* [ ROUTE ] ping */
        } else if (request.url.indexOf('__ping__') != -1) {
            response.writeHead(200, {'content-type': 'text/plain'});
            response.end('OK');
        /* [ ROUTE ] proxy to app */
        } else {
            var proxy_request2 = http.request({method:request.method,
                                              hostname: REMOTE_ADDR,
                                              port: REMOTE_PORT,
                                              path: request.url,
                                              headers: request.headers});
            proxy_request2.addListener('response', function(proxy_response) {
                proxy_response.addListener('data', function(chunk) {
                    response.write(chunk, 'binary');
                });
                proxy_response.addListener('end', function() {
                    response.end();
                });
                response.writeHead(proxy_response.statusCode, proxy_response.headers);
            });
            request.addListener('data', function(chunk) {
                proxy_request2.write(chunk, 'binary');
            });
            proxy_request2.addListener('error', function(err) {
                if (err.code == 'ECONNREFUSED') {
                    if (updatingCode) {
                        response.writeHead(503, {'content-type': 'text/plain'});
                        // TODO attempt to bring it back up
                        response.end('Updating code...');
                    } else {
                        response.writeHead(502, {'content-type': 'text/plain'});
                        // TODO attempt to bring it back up
                        response.end('Your app is down, try again in a few seconds. If it\'s not starting up, it might be because of a syntax error in your code, or a problem with the deployment container. Email us if the problem persists.');
                    }
                }
            });
            request.addListener('end', function() {
                proxy_request2.end();
            });
        }
    }).listen(LOCAL_PORT);
    return s;
};


var USAGE = 'Devmon, spawns app as subprocess and proxies TCP to it.\n'+
            'Listens for code updates and respawns.\n'+
            'Usage: node devmon.js PORT PROXYPORT CWD [ subprocess argv ] \n'+
            '        0      1        2      3      4        5 ... n ';

if (process.argv.length < 6) {
    devmon_log(USAGE);
    process.exit(1);
}

var port = process.argv[2],
    proxyport = process.argv[3],
    cwd = process.argv[4],
    app_cmd = process.argv[5],
    app_args = process.argv.slice(6);

process.chdir(cwd);
devmon_log('Changed CWD to ' + cwd);

console.log([app_cmd].concat(app_args));
spawnApp([app_cmd].concat(app_args));
spawnNodeInspector();

var proxySock = httpProxy(port, '127.0.0.1', proxyport);
