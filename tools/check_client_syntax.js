const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1. Read the server.js file
let code = fs.readFileSync(path.join(__dirname, 'app', 'server.js'), 'utf8');

// 2. Create the temp directory for mocks
if (!fs.existsSync('./mock_opt')) {
  fs.mkdirSync('./mock_opt');
}

// 3. Patch the file system paths in code to use local directory
code = code.replace(/\/opt\/vps-downloader/g, './mock_opt');
code = code.replace(/\/var\/downloads/g, './mock_opt');
code = code.replace(/app\.listen\(PORT,[\s\S]*?\);/, '/* app.listen skipped by syntax checker */');

// 4. Mock global things
const sandbox = {
  require: require,
  console: console,
  process: process,
  Buffer: Buffer,
  setInterval: () => {},
  clearInterval: () => {},
  __dirname: path.join(__dirname, 'app'),
  module: { exports: {} },
  exports: {},
  setTimeout: setTimeout,
  clearTimeout: clearTimeout
};

const dummyApp = {
  get: () => {},
  post: () => {},
  patch: () => {},
  delete: () => {},
  use: () => {},
  set: () => {},
};
sandbox.app = dummyApp;

// Create context and run the patched server.js
const context = vm.createContext(sandbox);
try {
  vm.runInContext(code, context, { filename: 'app/server.js' });
  
  // Call cloudPage to get the HTML
  console.log("Calling cloudPage('xf1st')...");
  const html = sandbox.cloudPage('xf1st');
  console.log("HTML generated successfully! Length:", html.length);
  
  // Extract <script> content
  const scripts = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  
  console.log(`Found ${scripts.length} script blocks.`);
  
  // Validate each script block using vm.Script
  scripts.forEach((scriptCode, index) => {
    console.log(`\n--- Validating Script Block #${index + 1} ---`);
    if (!scriptCode.trim()) {
      console.log("Empty script block, skipping.");
      return;
    }
    try {
      new vm.Script(scriptCode, { filename: `script_block_${index + 1}.js` });
      console.log("✓ Syntax is valid!");
    } catch (err) {
      console.error(`✗ Syntax error in script block #${index + 1}:`);
      console.error(err);
      
      // Print context around the error if line/column are available
      if (err.stack) {
        const lines = scriptCode.split('\n');
        // Parse the stack trace for line numbers
        const matchLine = /script_block_\d+\.js:(\d+):?(\d+)?/.exec(err.stack);
        if (matchLine) {
          const errLineNum = parseInt(matchLine[1], 10);
          console.log("\nContext around error:");
          for (let l = Math.max(0, errLineNum - 5); l < Math.min(lines.length, errLineNum + 5); l++) {
            const prefix = l === errLineNum - 1 ? ' > ' : '   ';
            console.log(`${prefix}${l + 1}: ${lines[l]}`);
          }
        }
      }
    }
  });
  
} catch (err) {
  console.error("Error running server.js in VM:", err);
}
