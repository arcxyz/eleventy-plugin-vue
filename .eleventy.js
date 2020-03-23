const path = require("path");
const fastglob = require("fast-glob");
const Vue = require("vue");
const rollup = require("rollup");
const rollupPluginVue = require("rollup-plugin-vue");
const rollupPluginCss = require("rollup-plugin-css-only");
const vueServerRenderer = require("vue-server-renderer");
const lodashMerge = require("lodash.merge");
const AssetManager = require("./src/AssetManager");

const globalOptions = {
  componentsDirectory: "",
  cacheDirectory: ".cache/11ty/vue/",
  // See https://rollup-plugin-vue.vuejs.org/options.html
  rollupPluginVueOptions: {}
};

function deleteFromRequireCache(componentPath) {
  let fullPath = path.join(path.normalize(path.resolve(".")), componentPath);
  delete require.cache[fullPath];
}

module.exports = function(eleventyConfig, configGlobalOptions = {}) {
  let options = Object.assign({}, globalOptions, configGlobalOptions);

  let components = {};
  let cssManager = new AssetManager();
  let workingDirectory = path.resolve(".");

  eleventyConfig.addTemplateFormats("vue");

  // This will probably only work in a layout template
  eleventyConfig.addFilter("getCss", (url) => {
    return cssManager.getCodeForUrl(url);
  });

  eleventyConfig.addExtension("vue", {
    // read: false,
    init: async function() {
      cssManager.init();

      let componentDir = options.componentsDirectory || path.join(this.config.inputDir, this.config.dir.includes);
      let searchGlob = path.join(workingDirectory, componentDir, "**/*.vue");
      let componentFiles = await fastglob(searchGlob, {
        caseSensitiveMatch: false
      });
      let rollupVueOptions = lodashMerge({
        css: false,
        template: {
          optimizeSSR: true
        }
        // compilerOptions: {} // https://github.com/vuejs/vue/tree/dev/packages/vue-template-compiler#options
      }, options.rollupPluginVueOptions);

      let plugins = [
        rollupPluginCss({
          output: (styles, styleNodes) => {
            cssManager.addRollupComponentNodes(styleNodes, ".vue");
          }
        }),
        rollupPluginVue(rollupVueOptions)
      ];

      let bundle = await rollup.rollup({
        input: componentFiles,
        plugins: plugins
      });

      let { output } = await bundle.write({
        // format: "esm"
        format: "cjs",
        dir: options.cacheDirectory
      });

      // Filter out the normalizer module
      // Careful, using __vue_normalize__ here may be brittle
      let normalizer = output.filter(entry => entry.exports.filter(exp => exp === "__vue_normalize__").length);
      let normalizerFilename;
      if(normalizer.length) {
        normalizerFilename = normalizer[0].fileName;
      }

      let compiledComponents = output.filter(entry => entry.fileName !== normalizerFilename);

      for(let entry of compiledComponents) {
        let key = AssetManager.getComponentNameFromPath(entry.fileName, ".js")
        let componentPath = path.join(options.cacheDirectory, entry.fileName);

        // If you import it, it will roll up the CSS
        let componentImports = entry.imports.filter(entry => !normalizerFilename || entry !== normalizerFilename);
        for(let importFilename of componentImports) {
          cssManager.addComponentRelationship(entry.fileName, importFilename, ".js");
        }

        deleteFromRequireCache(componentPath);
        components[key] = require(path.join(workingDirectory, componentPath));
        // Add universal JavaScript functions to components
        components[key].methods = Object.assign({}, this.config.javascriptFunctions, components[key].methods);
        // extra stuff for caching
        components[key].name = key;
        components[key].serverCacheKey = props => key;
      }
    },
    compile: function(str, inputPath) {
      return async (data) => {
        // abuse caching API to get components in use for every page
        // https://ssr.vuejs.org/api/#cache
        // TODO is there a better way to do this?
        const renderer = vueServerRenderer.createRenderer({
          cache: {
            get: (key) => {
              cssManager.addComponentForUrl(key.split("::").shift(), data.page.url);
            },
            set: (key, value) => {}
          }
        });

        const app = new Vue({
          template: str,
          data: data,
          // Add universal JavaScript functions to pages
          methods: this.config.javascriptFunctions,
          components: components // created in init()
        });

        return renderer.renderToString(app);
      };
    }
  });
};