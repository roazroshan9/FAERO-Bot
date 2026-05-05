# hooks/

Cordova build hooks — scripts that run automatically at various stages
of the build pipeline.

## Recommended hook: pre-build npm install

Create `hooks/before_build/npm_install.js` to auto-install the
`www/nodejs-project/` dependencies before every Gradle build:

```javascript
#!/usr/bin/env node
'use strict';
const path  = require('path');
const { execSync } = require('child_process');

module.exports = function (context) {
  const nodeDir = path.join(context.opts.projectRoot, 'www', 'nodejs-project');
  console.log('[hook] npm install in', nodeDir);
  execSync('npm install --production', { cwd: nodeDir, stdio: 'inherit' });
};
```

Register it in `config.xml`:

```xml
<hook type="before_build" src="hooks/before_build/npm_install.js" />
```

This ensures all your bot's npm dependencies are bundled into the APK
every time you build.
