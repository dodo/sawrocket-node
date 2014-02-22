module.exports = (grunt) ->

    grunt.initConfig
        pkg: grunt.file.readJSON('package.json')
        browserify:
            dist:
                files:
                    'sawrocket-node.browser.js': ['test.js']

    grunt.loadNpmTasks 'grunt-browserify'

    grunt.registerTask 'default', [
        'browserify'
    ]
