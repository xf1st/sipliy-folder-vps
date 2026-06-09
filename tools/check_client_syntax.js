const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 1. Create the temp directory for mocks (if needed)
if (!fs.existsSync('./mock_opt')) {
  fs.mkdirSync('./mock_opt');
}

// 2. Read the templates.js file
const templatesPath = path.join(__dirname, '..', 'app', 'templates.js');
let code = fs.readFileSync(templatesPath, 'utf8');

// 3. Mock global things for VM context
const sandbox = {
  require: (id) => {
    if (id === './db') {
      return {
        loadUsers: () => ({
          xf1st: { label: 'Admin', isAdmin: true }
        })
      };
    }
    if (id === './config') {
      return require('../app/config');
    }
    if (id === './utils') {
      return require('../app/utils');
    }
    if (id === 'path') {
      return require('path');
    }
    return require(id);
  },
  console: console,
  process: process,
  Buffer: Buffer,
  module: { exports: {} },
  exports: {},
  __dirname: path.dirname(templatesPath),
};

const context = vm.createContext(sandbox);

try {
  vm.runInContext(code, context, { filename: 'app/templates.js' });
  
  // Call cloudPage to get the HTML
  console.log("Calling cloudPage('xf1st')...");
  const templatesModule = sandbox.module.exports;
  const html = templatesModule.cloudPage('xf1st');
  console.log("HTML generated successfully! Length:", html.length);
  
  // Extract <script> content
  const scripts = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  
  console.log(`Found ${scripts.length} script blocks.`);
  
  let hasErrors = false;
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
      hasErrors = true;
      
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
  
  if (hasErrors) {
    process.exit(1);
  } else {
    console.log("\nAll client script blocks checked. No syntax errors found!");
  }
} catch (err) {
  console.error("Error running templates.js in VM:", err);
  process.exit(1);
}
