packageFilter =  (pkg) ->
    return pkg unless pkg.name is 'node-forge'
    ((pkg.browserify ?= {}).transform ?= []).push '../../save-deamdify'
    pkg

module.exports = (grunt) ->

    grunt.initConfig
        pkg: grunt.file.readJSON('package.json')
        browserify:
            dist:
                files:
                    'sawrocket-node.browser.js': ['test.js']
                options:
                    packageFilter:packageFilter

    grunt.loadNpmTasks 'grunt-browserify'

    grunt.registerTask 'default', [
        'browserify'
    ]

module.exports.packageFilter = packageFilter
