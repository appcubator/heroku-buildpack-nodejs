#!/usr/bin/env node

var fs = require('fs');
var child_process = require('child_process');
var http = require('http');
var formidable = require('formidable');

var DEBUG = true;

var devmon_log = function(s) {
    console.log('[Appcubator] ' + s);
};

var spawnApp = function () {
    var child_app = child_process.spawn(app_cmd, app_args, {env: process.env});

    child_app.stdout.on('data', function (data) {
      process.stdout.write(data);
    });

    child_app.stderr.on('data', function (data) {
      process.stderr.write(data);
    });

    child_app.on('close', function (code) {
      devmon_log('Child process exited with code ' + code);
    });

    return child_app;
};

var updateCode = function (tarpath, callback) {
    child_process.exec('tar -xvf '+tarpath, function(err, stdout, stderr) {
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
    var updatingCode = false;
    var s = http.createServer(function(request, response) {
        var ip = request.connection.remoteAddress;
        devmon_log(ip + ": " + request.method + " " + request.url);
        if (updatingCode) {
            response.writeHead(503, {'content-type': 'text/plain'});
            response.end('Updating code!');
        } else {
            if (request.url.indexOf('__update_code__') != -1) {
                updatingCode = true;
                var form = new formidable.IncomingForm();

                form.parse(request, function(err, fields, files) {
                    // Note: it will write this relative to the current working directory which should be appdir
                    if (err) {
                        updatingCode = false;
                        devmon_log(err);
                    } else {
                        devmon_log('Written out to '+files.code.path);
                        updateCode(files.code.path, function(){
                            app.kill();
                            devmon_log('Sent SIGTERM to app, now waiting.');
                            app.on('exit', function(){
                                devmon_log('Spawning app.');
                                // app is a global
                                app = spawnApp();
                                response.writeHead(200, {'content-type': 'text/plain'});
                                response.end('OK');
                                updatingCode = false;
                            });
                        });
                    }
                });
            } else if (request.url.indexOf('__ping__') != -1) {
                response.writeHead(200, {'content-type': 'text/plain'});
                response.end('OK');
            } else {
                //devmon_log(request);
                var proxy_request = http.request({method:request.method,
                                                  hostname: REMOTE_ADDR,
                                                  port: REMOTE_PORT,
                                                  path: request.url,
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
                        response.end('Your app is down.'); 
                    }
                });
                request.addListener('end', function() {
                    proxy_request.end();
                });
            }
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
// global
app = spawnApp();
var proxySock = httpProxy(port, '127.0.0.1', proxyport);
