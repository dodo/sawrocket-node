# [Saw Rocket](https://github.com/astro/sawrocket) for Node.js


Nodejs [net](http://nodejs.org/api/net.html), [tls](http://nodejs.org/api/tls.html) and [dgram](http://nodejs.org/api/dgram.html) module using the [Raw Socket API](http://www.w3.org/TR/raw-sockets).

## Current limitations

 * no Server in net and tls
 * [dns](https://github.com/tjfontaine/node-dns) can be used, but needs some [files](https://github.com/dodo/sawrocket-xmpp/blob/master/initrd.js) from [fs](https://github.com/juliangruber/level-fs-browser).
 * crypto is overloaded with the [forge module](https://github.com/digitalbazaar/forge) and adds missing `crypto.createCredentials` to the browser.


Browserify might help to build your node code for chrome/firefox extension:
```bash
browserify -r sawrocket-node:net entry.js > browser.js
```