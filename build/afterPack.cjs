const fs = require('node:fs');
const path = require('node:path');
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const files = [], dirs = [];
  const escape = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"').replaceAll('/', '\\');
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(context.appOutDir, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { walk(name); dirs.push(name); } else files.push(name);
    }
  }
  walk('');
  fs.writeFileSync(path.join(context.packager.projectDir, 'build/uninstall-files.nsh'), [...files.map(name => `Delete "$INSTDIR\\${escape(name)}"`), ...dirs.map(name => `RMDir "$INSTDIR\\${escape(name)}"`)].join('\n') + '\n');
};
