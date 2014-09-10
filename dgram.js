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

var assert = require('assert');
var util = require('util');
var events = require('events');
var rawsocket = require('sawrocket');
var Buffer = require('buffer').Buffer;
var SlowBuffer = require('buffer').SlowBuffer;

var BIND_STATE_UNBOUND = 0;
var BIND_STATE_BINDING = 1;
var BIND_STATE_BOUND = 2;

// lazily loaded
var dns = null;
var net = null;


// no-op callback
function noop() {
}


function isIP(address) {
  if (!net)
    net = require('net');

  return net.isIP(address);
}


function lookup(address, family, callback) {
  if (!dns)
    dns = require('dns');

  return dns.lookup(address, family, callback);
}


function lookup4(address, callback) {
  return lookup(address || '0.0.0.0', 4, callback);
}


function lookup6(address, callback) {
  return lookup(address || '::0', 6, callback);
}


function newHandle(type, options) {
  if (type == 'udp4' || type == 'udp6') {
    var handle = new rawsocket.UDPSocket(options);
    if (type == 'udp4')
      handle.lookup = lookup4;
    if (type == 'udp6')
      handle.lookup = lookup6;
    return handle;
  }

  if (type == 'unix_dgram')
    throw new Error('unix_dgram sockets are not supported any more.');

  throw new Error('Bad socket type specified. Valid types are: udp4, udp6');
}


exports._createSocketHandle = function(address, port, addressType, fd) {
  // Opening an existing fd is not supported for UDP handles.
  assert(typeof fd !== 'number' || fd < 0);

  if (port || address) {
    handle = newHandle(addressType, {
      localAddress:address,
      localPort:port || 0
    });
  }

  return handle;
};


function Socket(type, listener) {
  events.EventEmitter.call(this);

  var handle = newHandle(type);
  handle.owner = this;

  this._handle = handle;
  this._receiving = false;
  this._bindState = BIND_STATE_UNBOUND;
  this.type = type;
  this.fd = null; // compatibility hack

  if (typeof listener === 'function')
    this.on('message', listener);
}
util.inherits(Socket, events.EventEmitter);
exports.Socket = Socket;


exports.createSocket = function(type, listener) {
  return new Socket(type, listener);
};


function startListening(socket) {
  socket._handle.onmessage = onMessage;
  socket._handle.ondrain = onDrain;
  socket._handle.onerror = onError;
  // Todo: handle errors
  socket._receiving = true;
  socket._bindState = BIND_STATE_BOUND;
  socket.fd = -42; // compatibility hack

  socket.emit('listening');
}

function replaceHandle(self, newHandle) {

  // Set up the handle that we got from master.
  newHandle.lookup = self._handle.lookup;
  newHandle.owner = self;

  // Replace the existing handle by the handle we got from master.
  self._handle.close();
  self._handle = newHandle;
}

Socket.prototype.bind = function(/*port, address, callback*/) {
  var self = this;

  self._healthCheck();

  if (this._bindState != BIND_STATE_UNBOUND)
    throw new Error('Socket is already bound');

  this._bindState = BIND_STATE_BINDING;

  if (typeof arguments[arguments.length - 1] === 'function')
    self.once('listening', arguments[arguments.length - 1]);

  if (arguments[0] instanceof rawsocket.UDPSocket) {
    replaceHandle(self, arguments[0]);
    startListening(self);
    return;
  }

  var port = arguments[0]
  var address = arguments[1] || '0.0.0.0';
  if (typeof address === 'function') address = '';  // a.k.a. "any address"
  if (!address && !port && port != 0) {
    replaceHandle(self, newHandle(self.type));
    startListening(self);
    return;
  }

  // resolve address first
  self._handle.lookup(address, function(err, ip) {
    if (err) {
      self._bindState = BIND_STATE_UNBOUND;
      self.emit('error', err);
      return;
    }

    if (!self._handle)
      return; // handle has been closed in the mean time

    replaceHandle(self, newHandle(self.type, {
      localAddress: ip,
      localPort: port || 0,
    }));
    startListening(self);
  });
};


// thin wrapper around `send`, here for compatibility with dgram_legacy.js
Socket.prototype.sendto = function(buffer,
                                   offset,
                                   length,
                                   port,
                                   address,
                                   callback) {
  if (typeof offset !== 'number' || typeof length !== 'number')
    throw new Error('send takes offset and length as args 2 and 3');

  if (typeof address !== 'string')
    throw new Error(this.type + ' sockets must send to port, address');

  this.send(buffer, offset, length, port, address, callback);
};


Socket.prototype.send = function(buffer,
                                 offset,
                                 length,
                                 port,
                                 address,
                                 callback) {
  var self = this;

  if (!Buffer.isBuffer(buffer))
    throw new TypeError('First argument must be a buffer object.');

  offset = offset | 0;
  if (offset < 0)
    throw new RangeError('Offset should be >= 0');

  if (offset >= buffer.length)
    throw new RangeError('Offset into buffer too large');

  // Sending a zero-length datagram is kind of pointless but it _is_
  // allowed, hence check that length >= 0 rather than > 0.
  length = length | 0;
  if (length < 0)
    throw new RangeError('Length should be >= 0');

  if (offset + length > buffer.length)
    throw new RangeError('Offset + length beyond buffer length');

  port = port | 0;
  if (port <= 0 || port > 65535)
    throw new RangeError('Port should be > 0 and < 65536');

  callback = callback || noop;

  self._healthCheck();

  if (self._bindState == BIND_STATE_UNBOUND)
    self.bind(port, address);
//     self.bind(0, null);

  // If the socket hasn't been bound yet, push the outbound packet onto the
  // send queue and send after binding is complete.
  if (self._bindState != BIND_STATE_BOUND) {
    // If the send queue hasn't been initialized yet, do it, and install an
    // event handler that flushes the send queue after binding is done.
    if (!self._sendQueue) {
      self._sendQueue = [];
      self.once('listening', function() {
        // Flush the send queue.
        for (var i = 0; i < self._sendQueue.length; i++)
          self.send.apply(self, self._sendQueue[i]);
        self._sendQueue = undefined;
      });
    }
    self._sendQueue.push([buffer, offset, length, port, address, callback]);
    return;
  }

  self._handle.lookup(address, function(err, ip) {
    if (err) {
      if (callback) callback(err);
      self.emit('error', err);
    } else if (self._handle) {
      var enc;
      if (self._handle.send(buffer.buffer, ip, port)) {
        if (callback) callback(null, self);
      } else if (callback)  {
        self._afterSends = self._afterSends || [];
        self._afterSends.push(callback);
      }
    }
  });
};

Socket.prototype.close = function() {
  this._healthCheck();
  this._stopReceiving();
  this._handle.close();
  this._handle = null;
  this.emit('close');
};


Socket.prototype._getsockname = function() {
  if (!this._handle) {
    return {};
  }
  return {
    address:this._handle.localAddress,
    port:   this._handle.localPort,
  };
};

Socket.prototype.address = function() {
  this._healthCheck();
  return this._getsockname().address;
};


Socket.prototype.setBroadcast = function(arg) {
  this._handle.setBroadcast(arg ? 1 : 0);
};


Socket.prototype.setTTL = noop;


Socket.prototype.setMulticastTTL = function(arg) {
  if (typeof arg !== 'number') {
    throw new TypeError('Argument must be a number');
  }
  this._handle.setMulticastTTL(arg);
  return arg;
};


Socket.prototype.setMulticastLoopback = function(arg) {
  arg = arg ? 1 : 0;
  this._handle.setMulticastLoopback(arg);
  return arg; // 0.4 compatibility
};


Socket.prototype.addMembership = function(multicastAddress) {
  this._healthCheck();

  if (!multicastAddress) {
    throw new Error('multicast address must be specified');
  }
  this._handle.joinMulticastGroup(multicastAddress);
};


Socket.prototype.dropMembership = function(multicastAddress) {
  this._healthCheck();

  if (!multicastAddress) {
    throw new Error('multicast address must be specified');
  }
  this._handle.leaveMulticastGroup(multicastAddress);
};


Socket.prototype._healthCheck = function() {
  if (!this._handle)
    throw new Error('Not running'); // error message from dgram_legacy.js
};


Socket.prototype._stopReceiving = function() {
  if (!this._receiving)
    return;

  this._receiving = false;
  this.fd = null; // compatibility hack
};

Socket.prototype.ref = noop;
Socket.prototype.unref = noop;


function afterSend(self) {
  self._afterSends.forEach(function (cb) { cb.call(null, self) });
  self._afterSends = null;
}

function onMessage(ev) {
  var self = this.owner;
  var nread = ev.data.byteLength;
  var array = new Uint8Array(ev.data, 0, nread);
  var rinfo = {size:nread, address:ev.address, port:ev.port};
  array.__proto__.__proto__ = Object.create(SlowBuffer.prototype);
  var buffer = new Buffer(array, array.length, 0);
  self.emit('message', buffer, rinfo);
}

// This function is called whenever it is possible to write to handle again
function onDrain() {
  var self = this.owner;

  if (self._afterSends)
    afterSend(self);
}

// This function is called whenever the handle throws an error
function onError(ev) {
  var self = this.owner;

  var err = ev || ev.data;
  debug('onerror', err);

  self.emit('error', err);
}
