/**
 * Simulate node's TLS wrapper using Forge
 * borrowed from https://github.com/hiddentao/browsermail
 * https://github.com/hiddentao/browsermail/blob/master/src/js/node-polyfills/tls.js
 * and ported to nodejs api v0.11
 */
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var crypto = require('./crypto');

function noop() {}

var CLIENT_TO_SERVER = 1;
var SERVER_TO_CLIENT = 2;
var debug = util.debuglog ? (function () {
    var log = util.debuglog('tls');
    return function (msg, direction, contentType) {
      switch (direction) {
        case CLIENT_TO_SERVER:
          direction = '{c -> S}: ';
          break;
        case SERVER_TO_CLIENT:
          direction = '{S -> c}: ';
          break;
        default:
          direction = '';
      }
      msg = ('enc' !== contentType ? msg : '(enc) ' + crypto.forge.util.bytesToHex(msg));
      log(direction + msg);
    }
})() : noop;



function TLSSocket(socket, options) {
  if (!options) {options = socket;socket = null}
  var self = this;

  this._socket = socket || options.socket;

  // To prevent assertion in afterConnect()
  if (this._socket)
    this._connecting = this._socket._connecting;

  this.id = this._socket._handle.socketId;
  this._tlsOptions = options;
  this.authorizationError = null;
  this.authorized = false;
  this.writable = false;

  var ctx = (options.credentials || crypto.createCredentials()).context;

  // create TLS connection
  this.ssl = crypto.forge.tls.createConnection({
    server: typeof options.isServer === 'undefined' ? false : options.isServer,
    verifyClient: options.requestCert ? options.rejectUnauthorized ? true : 'optional' : false,
    error: onError.bind(this),
    closed: onClosed.bind(this),
    connected: onConnected.bind(this),
    dataReady: onDataReady.bind(this),
    tlsDataReady: onTlsDataReady.bind(this),
//     getCertificate: ctx.getCert.bind(ctx), // FIXME
//     getPrivateKey: ctx.getKey.bind(ctx),  // FIXME
//     getSignature: ctx.sign.bind(ctx),    // FIXME
    deflate: ctx.deflate && ctx.deflate.bind(ctx),
    inflate: ctx.inflate && ctx.inflate.bind(ctx),
    sessionCache: ctx.session.cache,
    cipherSuites: ctx.cipherSuites,
    virtualHost: ctx.virtualHost,
    sessionId: ctx.session.id,
    caStore: ctx.caStore || [],
    verify: ctx.verify && ctx.verify.bind(ctx) ||
      function(conn, verified, depth, certs) {
        return true; // FIXME
      },
  });

  this._socket.on('close', function(had_err) {
    if(self.ssl.open && self.ssl.handshaking) {
      self.emit('error', new Error('Connection closed during handshake.'));
    }

    self.ssl.close();

    // call socket handler
    self.emit('close', had_err);
  });

  // handle error on socket
  this._socket.on('error', function(e) {
    debug('Socket error: ' + (e.message || e));

    // error
    self.emit('error', e);
  });

  // handle receiving raw TLS data from socket
  this._socket.on('data', function(data) {
    var bytes = data.toString('binary');
    debug(bytes, SERVER_TO_CLIENT, 'enc');

    self.ssl.process(bytes);
  });

  if (!this._socket)
    // handle doing handshake after connecting
    this._socket.once('connect', this._init.bind(this, ctx));
  else
    this._init(ctx);
};
util.inherits(TLSSocket, EventEmitter);
exports.TLSSocket = TLSSocket;

TLSSocket.prototype._init = function(ctx) {
  debug('Socket connected. Handshaking...');
  this.ssl.handshake(ctx.session.id);
};

TLSSocket.prototype.serializeStanza = function (el, cb) {
    return cb(el.toString());
};

 /**
  * Determines if the socket is connected or not.
  *
  * @return true if connected, false if not.
  */
TLSSocket.prototype.isConnected = function() {
  return this.ssl.isConnected;
};

  /**
   * Destroys this socket.
   */
TLSSocket.prototype.destroy = function() {
  var socket = this._socket;
  this._socket = null;
  if (socket) socket.destroy();
};

  /**
   * Connects this socket.
   */
TLSSocket.prototype.connect = function(port, host) {
  debug('Connecting to ' + host + ':' + port);
  this._socket.connect(port, host);
};

  /**
   * Closes this socket.
   */
TLSSocket.prototype.close = function() {
  debug('Closing connection');
  this.ssl.close();
};

  /**
   * Close this socket.
   * @type {Function}
   */
TLSSocket.prototype.end = TLSSocket.prototype.close;

  /**
   * Writes bytes to this socket.
   *
   * @param bytes the bytes (as a string) to write.
   *
   * @return true on success, false on failure.
   */
TLSSocket.prototype.write = function(bytes) {
  debug(bytes, CLIENT_TO_SERVER);
  return this.ssl.prepare(bytes);
};


TLSSocket.prototype.getCipher = function(bytes) {
  debug(bytes, CLIENT_TO_SERVER, 'cipher');
  return this.ssl.prepare(bytes);
};

TLSSocket.prototype._start = noop;
TLSSocket.prototype._releaseControl = noop;
TLSSocket.prototype.setSession = noop;
TLSSocket.prototype.setServername = noop;

function onConnected(conn) {
  debug('Handshake successful');
  // first handshake complete, call handler
  if(conn.handshakes === 1) {
    this.writable = true;
    this.authorized = true;
    this.emit('secureConnect');
  }
}

function onTlsDataReady(conn) {
  var bytes = conn.tlsData.getBytes();
  debug(bytes, CLIENT_TO_SERVER, 'enc');
  // send TLS data over socket
  this._socket.write(bytes, 'binary', function(err) {
    if (err) {
      this.emit('error', err);
    }
  }.bind(this));
}

function onDataReady(conn) {
  var received = conn.data.getBytes();
  debug(received, SERVER_TO_CLIENT, 'plain');
  // indicate application data is ready
  this.emit('data', new Buffer(received, 'binary'));
}

function onClosed() {
  debug('closed');
  this.writable = false;
  this.authorized = false;
  this.destroy();
}

function onError(conn, e) {
  debug('Error: ' + e.message || e);
  // send error, close socket
  this.authorizationError = e; // FIXME probably not right
  this.emit('error', e);
  this._socket.end();
}


exports.connect = function(options, onconnect) {
  var socket = new TLSSocket(options);
  if (onconnect) {
    socket.on('secureConnect', onconnect);
  }
  return socket;
};

