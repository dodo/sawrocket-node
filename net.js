// Copyright Joyent, Inc. and other Node contributors.
// Modified to work with the Raw Socket API
// http://www.w3.org/TR/raw-sockets
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var events = require('events');
var stream = require('stream');
var util = require('util');
var assert = require('assert');
var rawsocket = require('sawrocket');

var errnoException = util._errnoException;

function noop() {}

// constructor for lazy loading
function createUDP(options) {
  var UDPSocket = rawsocket.UDPSocket;
  return new UDPSocket(options);
}

// constructor for lazy loading
function createTCP(host, port, options) {
  var TCPSocket = rawsocket.TCPSocket;
  return new TCPSocket(host, port, options);
}


var debug = util.debuglog ? util.debuglog('net') : noop;


// exports.createServer = function() {
//   return new Server(arguments[0], arguments[1]);
// };


// Target API:
//
// var s = net.connect({port: 80, host: 'google.com'}, function() {
//   ...
// });
//
// There are various forms:
//
// connect(options, [cb])
// connect(port, [host], [cb])
//
exports.connect = exports.createConnection = function() {
  var args = normalizeConnectArgs(arguments);
  debug('createConnection', args);
  var s = new Socket(args[0]);
  return Socket.prototype.connect.apply(s, args);
};

// Returns an array [options] or [options, cb]
// It is the same as the argument of Socket.prototype.connect().
function normalizeConnectArgs(args) {
  var options = {};

  if (util.isObject(args[0])) {
    // connect(options, [cb])
    options = args[0];
  } else {
    // connect(port, [host], [cb])
    options.port = args[0];
    if (util.isString(args[1])) {
      options.host = args[1];
    }
  }

  var cb = args[args.length - 1];
  return util.isFunction(cb) ? [options, cb] : [options];
}
exports._normalizeConnectArgs = normalizeConnectArgs;


// called when creating new Socket, or when re-using a closed Socket
function initSocketHandle(self) {
  self.destroyed = false;
  self.errorEmitted = false;
  self.bytesRead = 0;
  self.__defineGetter__('_bytesDispatched', function() {
    return self._handle ? self._handle.bufferedAmount : 0;
  });

  // Handle creation may be deferred to bind() or connect() time.
  if (self._handle) {
    self._handle.owner = self;
    self._handle.onhalfclose = onhalfclose;
    self._handle.onmessage = onmessage;
    self._handle.ondrain = ondrain;
    self._handle.onerror = onerror;
    self._handle.onclose = onclose;
    self._handle.onopen = onopen;
  }
}

function Socket(options) {
  if (!(this instanceof Socket)) return new Socket(options);

  this._connecting = false;
  this._handle = null;

  if (util.isUndefined(options))
    options = {};

  stream.Duplex.call(this, options);

  this._type = (options.type == 'udp' ? 'udp' : 'tcp');

  if (options.handle) {
    this._handle = options.handle; // private
  } else {
    // these will be set once there is a connection
    this.readable = this.writable = false;
  }

  // shut down the socket when we're finished with it.
  this.on('finish', onSocketFinish);
  this.on('_socketEnd', onSocketEnd);

  initSocketHandle(this);

  this._pendingData = null;

  // handle strings directly
  this._writableState.decodeStrings = false;

  // if we have a handle, then start the flow of data into the
  // buffer.  if not, then this will happen when we connect
  if (this._handle && options.readable !== false)
    this.read(0);
}
util.inherits(Socket, stream.Duplex);

// the user has called .end(), and all the bytes have been
// sent out to the other side.
function onSocketFinish() {
  // If still connecting - defer handling 'finish' until 'connect' will happen
  if (this._connecting) {
    debug('osF: not yet connected');
    return this.once('connect', onSocketFinish);
  }

  debug('onSocketFinish');
  if (!this.readable || this._readableState.ended) {
    debug('oSF: ended, destroy', this._readableState);
    return this.destroy();
  }

  debug('oSF: not ended, call shutdown()');

  // otherwise, just shutdown, or destroy() if not possible
  if (this._handle)
    this._handle._shutdown = true;
  return this.destroy();
}


function afterShutdown(self, handle) {
  debug('afterShutdown destroyed=%j', self.destroyed,
        self._readableState);

  // callback may come after call to destroy.
  if (self.destroyed)
    return;

  if (self._readableState.ended) {
    debug('readableState ended, destroying');
    self.destroy();
  } else {
    self.once('_socketEnd', self.destroy);
  }
}

// the EOF has been received, and no more bytes are coming.
// if the writable side has ended already, then clean everything
// up.
function onSocketEnd() {
  // XXX Should not have to do as much crap in this function.
  // ended should already be true, since this is called *after*
  // the EOF errno and onmessage has eof'ed
  debug('onSocketEnd', this._readableState);
  this._readableState.ended = true;
  if (this._readableState.endEmitted) {
    this.readable = false;
    maybeDestroy(this);
  } else {
    this.once('end', function() {
      this.readable = false;
      maybeDestroy(this);
    });
    this.read(0);
  }

  this.write = writeAfterFIN;
  this.destroySoon();
}

// Provide a better error message when we call end() as a result
// of the other side sending a FIN.  The standard 'write after end'
// is overly vague, and makes it seem like the user's code is to blame.
function writeAfterFIN(chunk, cb) {
  var er = new Error('This socket has been ended by the other party');
  er.code = 'EPIPE';
  var self = this;
  // TODO: defer error events consistently everywhere, not just the cb
  self.emit('error', er);
  if (util.isFunction(cb)) {
    process.nextTick(function() {
      cb(er);
    });
  }
}

exports.Socket = Socket;
exports.Stream = Socket; // Legacy naming.

Socket.prototype.read = function(n) {
  if (n === 0)
    return stream.Readable.prototype.read.call(this, n);

  this.read = stream.Readable.prototype.read;
  this._consuming = true;
  return this.read(n);
};


Socket.prototype.listen = function() {
  debug('socket.listen');
  var self = this;
  self.on('connection', arguments[0]);
  listen(self, null, null, null);
};


Socket.prototype.setTimeout = function(msecs, callback) {
  throw new Error('Socket.setTimeout is not implemented');
};


Socket.prototype._onTimeout = function() {
  debug('_onTimeout');
  this.emit('timeout');
};


Socket.prototype.setNoDelay = function(enable) {
  // backwards compatibility: assume true when `enable` is omitted
  if (this._handle && this._handle.setNoDelay)
    this._handle.setNoDelay(util.isUndefined(enable) ? true : !!enable);
};


Socket.prototype.setKeepAlive = function(setting, msecs) {
  if (this._handle && this._handle.setKeepAlive)
    this._handle.setKeepAlive(setting, ~~(msecs / 1000));
};


Socket.prototype.address = function() {
  if (this._handle && this._handle.getsockname) {
    var out = {};
    var err = this._handle.getsockname(out);
    // TODO(bnoordhuis) Check err and throw?
    return out;
  }
  return null;
};


Object.defineProperty(Socket.prototype, 'readyState', {
  get: function() {
    if (this._connecting) {
      return 'opening';
    } else if (this.readable && this.writable) {
      return 'open';
    } else if (this.readable && !this.writable) {
      return 'readOnly';
    } else if (!this.readable && this.writable) {
      return 'writeOnly';
    } else {
      return 'closed';
    }
  }
});


Object.defineProperty(Socket.prototype, 'bufferSize', {
  get: function() {
    if (this._handle) {
      return this._handle.writeQueueSize + this._writableState.length;
    }
  }
});


// Just call handle.resume until we have enough in the buffer
Socket.prototype._read = function(n) {
  debug('_read');

  if (this._connecting || !this._handle) {
    debug('_read wait for connection');
    this.once('connect', this._read.bind(this, n));
  } else if (!this._handle.reading) {
    // not already reading, start the flow
    debug('Socket._read resume');
    this._handle.reading = true;
    this._handle.resume();
  }
};


Socket.prototype.end = function(data) {
  stream.Duplex.prototype.end.call(this, data);
  this.writable = false;

  // just in case we're waiting for an EOF.
  if (this.readable && !this._readableState.endEmitted)
    this.read(0);
  else
    maybeDestroy(this);
};


// Call whenever we set writable=false or readable=false
function maybeDestroy(socket) {
  if (!socket.readable &&
      !socket.writable &&
      !socket.destroyed &&
      !socket._connecting &&
      !socket._writableState.length) {
    socket.destroy();
  }
}


Socket.prototype.destroySoon = function() {
  if (this.writable)
    this.end();

  if (this._writableState.finished)
    this.destroy();
  else
    this.once('finish', this.destroy);
};


Socket.prototype._destroy = function(exception, cb) {
  debug('destroy');

  var self = this;

  function fireErrorCallbacks() {
    if (cb) cb(exception);
    if (exception && !self.errorEmitted) {
      process.nextTick(function() {
        self.emit('error', exception);
      });
      self.errorEmitted = true;
    }
  };

  if (this.destroyed) {
    debug('already destroyed, fire error callbacks');
    fireErrorCallbacks();
    return;
  }

  self._connecting = false;

  this.readable = this.writable = false;

  debug('close');
  if (this._handle) {
    debug('close handle');
    this._isException = exception ? true : false;
    if (this._handle.readyState !== 'closed') this._handle.close();
    this._handle.onmessage = noop;
    this._handle.onopen = noop;
    this._handle = null;
  }

  fireErrorCallbacks();
  this.destroyed = true;

  if (this.server) {
    debug('has server');
    this.server._connections--;
    if (this.server._emitCloseIfDrained) {
      this.server._emitCloseIfDrained();
    }
  }
};


Socket.prototype.destroy = function(exception) {
  debug('destroy', exception);
  this._destroy(exception);
};


// This function is called whenever the handle throws an error
function onopen() {
  var handle = this;
  var self = handle.owner;
  assert(handle === self._handle, 'handle != self._handle');

  debug('onopen');
  if (self._connecting)
      afterConnect(self, handle);
  self.emit('error');
}

// This function is called whenever the handle connection closes
function onclose() {
  var handle = this;
  var self = handle.owner;

  debug('onclose');

  handle.onerror = noop;
  handle.onclose = noop;
  handle.onhalfclose = noop;

  if (!self._shutdown)
    self.destroy();
  self.emit('close', self._isException);
  if (self._shutdown)
    afterShutdown(self, handle);

}

// This function is called whenever the handle connection half closes
function onhalfclose() {
  var handle = this;
  var self = handle.owner;

  debug('onhalfclose FIXME');

  // FIXME
}

// This function is called whenever the handle throws an error
function onerror(ev) {
  var handle = this;
  var self = handle.owner;

  var err = ev.data;
  debug('onerror', err);

  self.emit('error', err);
}

// This function is called whenever it is possible to write to handle again
function ondrain() {
  var handle = this;
  var self = handle.owner;

  debug('ondrain');

  if (self._afterWrites)
    afterWrite(self, handle);
}

// This function is called whenever the handle gets a
// buffer, or when there's an error reading.
function onmessage(ev) {
  var handle = this;
  var self = handle.owner;
  assert(handle === self._handle, 'handle != self._handle');

  var nread = ev.data.length, buffer = ev.data;
  debug('onmessage', nread);

  if (nread > 0) {
    debug('got data');

    // read success.
    // In theory (and in practice) calling suspend right now
    // will prevent this from being called again until _read() gets
    // called again.

    // if it's not enough data, we'll just call handle.resume()
    // again right away.
    self.bytesRead += nread;

    // Optimization: emit the original buffer with end points
    var ret = self.push(buffer);

    if (handle.reading && !ret) {
      handle.reading = false;
      debug('suspend');
      var err = handle.suspend();
      if (err)
        self._destroy(errnoException(err, 'read'));
    }
    return;
  }

  // if we didn't get any bytes, that doesn't necessarily mean EOF.
  // wait for the next one.
  if (nread === 0) {
    debug('not any data, keep waiting');
    return;
  }

  // Error, possibly EOF.
//   if (nread !== uv.UV_EOF) {
//     return self._destroy(errnoException(nread, 'read'));
//   }

  debug('EOF');

  if (self._readableState.length === 0) {
    self.readable = false;
    maybeDestroy(self);
  }

  // push a null to signal the end of data.
  self.push(null);

  // internal end event so that we know that the actual socket
  // is no longer readable, and we can start the shutdown
  // procedure. No need to wait for all the data to be consumed.
  self.emit('_socketEnd');
}


Socket.prototype._getpeername = function() {
  if (!this._handle) {
    return {};
  }
  if (!this._peername) {
    this._peername = {
      address: this._handle.remoteAddress,
      port:    this._handle.remotePort,
    };
  }
  return this._peername;
};


Socket.prototype.__defineGetter__('remoteAddress', function() {
  return this._getpeername().address;
});


Socket.prototype.__defineGetter__('remotePort', function() {
  return this._getpeername().port;
});


Socket.prototype._getsockname = function() {
  if (!this._handle) {
    return {};
  }
  if (!this._sockname) {
    this._sockname = {
      address:this._handle.localAddress,
      port:   this._handle.localPort,
    };
  }
  return this._sockname;
};


Socket.prototype.__defineGetter__('localAddress', function() {
  return this._getsockname().address;
});


Socket.prototype.__defineGetter__('localPort', function() {
  return this._getsockname().port;
});


Socket.prototype.write = function(chunk, cb) {
  if (!util.isString(chunk) && !util.isBuffer(chunk))
    throw new TypeError('invalid data');
  return stream.Duplex.prototype.write.apply(this, arguments);
};


Socket.prototype._write = function(data, cb) {
  // If we are still connecting, then buffer this for later.
  // The Writable logic will buffer up any more writes while
  // waiting for this one to be done.
  if (this._connecting) {
    this._pendingData = data;
    this.once('connect', function() {
      this._write(data, cb);
    });
    return;
  }
  this._pendingData = null;

  if (!this._handle) {
    this._destroy(new Error('This socket is closed.'), cb);
    return false;
  }

  if (this._handle.send(data)) {
    cb();
  } else {
    this._handle._afterWrites = this._handle._afterWrites || [];
    this._handle._afterWrites.push(cb);
  }
};


Socket.prototype.__defineGetter__('bytesWritten', function() {
  var bytes = this._bytesDispatched,
      state = this._writableState,
      data = this._pendingData;

  state.buffer.forEach(function(el) {
    bytes += el.chunk.length;
  });

  if (data) {
    bytes += data.length;
  }

  return bytes;
});


function afterWrite(self, handle) {
  debug('afterWrite');

  // callback may come after call to destroy.
  if (self.destroyed) {
    debug('afterWrite destroyed');
    return;
  }

  self._afterWrites.forEach(function (cb) { cb.call(self) });
  self._afterWrites = null;
}


function connect(self, handleOptions, address, port, addressType) {
  assert.ok(self._connecting);

  if (!self._handle) {
    port = port | 0;
    if (port <= 0 || port > 65535)
      throw new RangeError('Port should be > 0 and < 65536');
    self._handle = (self._type == 'tcp' ?
      createTCP(address, port, handleOptions) :
      createUDP(handleOptions));
    initSocketHandle(self);
  }
}


Socket.prototype.connect = function(options, cb) {
  if (this.write !== Socket.prototype.write)
    this.write = Socket.prototype.write;

  if (!util.isObject(options)) {
    // Old API:
    // connect(port, [host], [cb])
    var args = normalizeConnectArgs(arguments);
    return Socket.prototype.connect.apply(this, args);
  }

  if (this.destroyed) {
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finished = false;
    this.destroyed = false;
    this._handle = null;
  }


  if (util.isFunction(cb)) {
    this.once('connect', cb);
  }

  this._connecting = true;
  this.writable = true;

  if (!options.host) {
    debug('connect: missing host');
    connect(this, options.native, '127.0.0.1', options.port, 4);

  } else {
    var family = options.family || 4;
    var host = options.host || (family === 4 ? '127.0.0.1' : '0:0:0:0:0:0:0:1');
    debug('connect: find to host ' + host);
    connect(this, options.native, host, options.port, family);
  }
  return this;
};


Socket.prototype.ref = noop;
Socket.prototype.unref = noop;


function afterConnect(self, handle) {
  // callback may come after call to destroy
  if (self.destroyed)
    return;

  debug('afterConnect');

  assert.ok(self._connecting);
  self._connecting = false;

  self.readable = true;
  self.writable = true;

  self.emit('connect');

  // start the first read, or get an immediate EOF.
  // this doesn't actually consume any bytes, because len=0.
  if (readable)
    self.read(0);
}

// SERVER


exports.isIP = function(input) {
  return (exports.isIPv4(input) && 4) || (exports.isIPv6(input) && 6) || 0;
};

// robbed from https://github.com/Baggz/Robb

exports.isIPv4 = function(input) {
  return /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(input);
};

exports.isIPv6 = function(input) {
  return /(?:(?:[a-f\d]{1,4}:)*(?:[a-f\d]{1,4}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:(?:[a-f\d]{1,4}:)*[a-f\d]{1,4})?::(?:(?:[a-f\d]{1,4}:)*(?:[a-f\d]{1,4}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}))?)/.test(item);
};


exports._setSimultaneousAccepts = function(handle) {};
