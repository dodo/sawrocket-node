var through = require('through');
var RE_DEFINE = /define\([^\[]*(\[[^\]]*\])/;

module.exports = function (file) {
    return through(write, end);

    function write(buf) {
        this.emit('data', buf.toString('utf8').replace(RE_DEFINE, function (code, mods) {
            code = "};" + code;
            JSON.parse(mods.replace(/'/g,'"')).reverse().forEach(function (mod) {
                if (mod === 'require' || mod === 'module') return;
                code = "require('" + mod + "');" + code;
            })
            return "if(0){" + code;
        }));
    }

    function end() {
        this.emit('end');
    }
};