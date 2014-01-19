var constants = require('constants');
var stream = require('stream');
var util = require('util');

// override crypto module to monkey patch createCredentials
var crypto = module.exports = exports = require('crypto');
// needs ./save-deamdify as transform
exports.forge = require('node-forge')({disableNativeCode: true});

crypto.forge.pkcs12.privateKeyFromPem = function(pem, passphrase) {
  var msg = crypto.forge.pem.decode(pem)[0];

  if(msg.type !== 'PRIVATE KEY' && msg.type !== 'RSA PRIVATE KEY') {
    throw {
      message: 'Could not convert private key from PEM; PEM header type is ' +
        'not "PRIVATE KEY" or "RSA PRIVATE KEY".',
      headerType: msg.type
    };
  }
  if(msg.procType && msg.procType.type === 'ENCRYPTED') {
    throw {
      message: 'Could not convert private key from PEM; PEM is encrypted.'
    };
  }

  // convert DER to ASN.1 object
  var obj = asn1.fromDer(msg.body);

  return crypto.forge.pkcs12.pkcs12FromAsn1(obj, passphrase);
};


function SecureContext() {
  if (!(this instanceof SecureContext)) {
    return new SecureContext();
  }
}

SecureContext.prototype.init = function(secureProtocol) {
  this.caStore = crypto.forge.pki.createCaStore();
  this.session = {cache:{}};
}

SecureContext.prototype.loadPKCS12 = function(pem, passphrase) {
  this.key = crypto.forge.pkcs12.privateKeyFromPem(pem, passphrase);
}

SecureContext.prototype.setKey = function(pem, passphrase) {
  if (passphrase) {
    this.key = crypto.forge.pki.decryptRsaPrivateKey(pem, passphrase);
  } else {
    this.key = crypto.forge.pki.privateKeyFromPem(pem);
  }
}

SecureContext.prototype.getKey = function() {
  return this.key;
}

SecureContext.prototype.setCert = function(pem) {
  this.cert = crypto.forge.pki.certificateFromPem(pem);
}

SecureContext.prototype.getCert = function() {
  return this.cert;
}

SecureContext.prototype.setCiphers = function() {
 // FIXME
}

SecureContext.prototype.getCiphers = function() {
 // FIXME

}

SecureContext.prototype.setECDHCurve = function() {
 // FIXME

}

SecureContext.prototype.addCRL = function() { // Certificate Revocation List
 // FIXME

}

SecureContext.prototype.addCACert = function(pem) {
  this.caStore.addCertificate(pem);
}

SecureContext.prototype.addRootCerts = function() {
  // there is no way to get them from the browser
}

SecureContext.prototype.setSessionIdContext = function(ctx) {
  this.session.id = ctx.id;
}

SecureContext.prototype.sign = function() {
 // FIXME
}

SecureContext.prototype.verify = function (conn, verified, depth, certs) {
  return true; // FIXME
//   var issuerCert = this.caStore.getIssuer(this.cert); // FIXME
//   return certs.every(function (cert) {
//     return issuerCert.verify(cert);
//   });
}


// This is here because many functions accepted binary strings without
// any explicit encoding in older versions of node, and we don't want
// to break them unnecessarily.
function toBuf(str, encoding) {
  encoding = encoding || 'binary';
  if (util.isString(str)) {
    if (encoding === 'buffer')
      encoding = 'binary';
    str = new Buffer(str, encoding);
  }
  return str;
}

function Credentials(secureProtocol, flags, context) {
  if (!(this instanceof Credentials)) {
    return new Credentials(secureProtocol, flags, context);
  }

  if (context) {
    this.context = context;
  } else {
    this.context = new SecureContext();

    if (secureProtocol) {
      this.context.init(secureProtocol);
    } else {
      this.context.init();
    }
  }

  if (flags) this.context.setOptions(flags);
}

exports.Credentials = Credentials;


exports.createCredentials = function(options, context) {
  if (!options) options = {};

  var c = new Credentials(options.secureProtocol,
                          options.secureOptions,
                          context);

  if (context) return c;

  if (options.key) {
    if (options.passphrase) {
      c.context.setKey(options.key, options.passphrase);
    } else {
      c.context.setKey(options.key);
    }
  }

  if (options.cert) c.context.setCert(options.cert);

  if (options.ciphers) c.context.setCiphers(options.ciphers);

  if (options.ecdhCurve) c.context.setECDHCurve(options.ecdhCurve);

  if (options.ca) {
    if (util.isArray(options.ca)) {
      for (var i = 0, len = options.ca.length; i < len; i++) {
        c.context.addCACert(options.ca[i]);
      }
    } else {
      c.context.addCACert(options.ca);
    }
  } else {
    c.context.addRootCerts();
  }

  if (options.crl) {
    if (util.isArray(options.crl)) {
      for (var i = 0, len = options.crl.length; i < len; i++) {
        c.context.addCRL(options.crl[i]);
      }
    } else {
      c.context.addCRL(options.crl);
    }
  }

  if (options.sessionIdContext) {
    c.context.setSessionIdContext(options.sessionIdContext);
  }

  if (options.pfx) {
    var pfx = options.pfx;
    var passphrase = options.passphrase;

    pfx = toBuf(pfx);
    if (passphrase)
      passphrase = toBuf(passphrase);

    if (passphrase) {
      c.context.loadPKCS12(pfx, passphrase);
    } else {
      c.context.loadPKCS12(pfx);
    }
  }

  return c;
};