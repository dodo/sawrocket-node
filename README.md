# [Saw Rocket](https://github.com/astro/sawrocket) for Node.js


Nodejs [Net Module](http://nodejs.org/api/net.html) using the [Raw Socket API](http://www.w3.org/TR/raw-sockets).

ATM only Socket implemented.


Browserify might help to build your node code for chrome/firefox extension:
```bash
browserify -r sawrocket-node:net entry.js > browser.js
```