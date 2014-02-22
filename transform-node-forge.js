var path = require('path');
var through = require('through');
var viralify = require('viralify');

module.exports = function (file) {
    // only run once
    if (process.env.BROWSERIFY_SKIP_NODE_FORGE_TRANSFORM) return through();
    process.env.BROWSERIFY_SKIP_NODE_FORGE_TRANSFORM = true;
    var relpath = path.relative(process.cwd(), __dirname);
    var data = '';
    viralify.sync(__dirname, 'node-forge', 'deamdify', 'infront');
    return through();
}