require('util').debuglog = function (tag) {
    return console.log.bind(console, tag+":");
};

var net = require('net');
if (window) window.net = net;

var tls = require('tls');
if (window) window.tls = tls;

