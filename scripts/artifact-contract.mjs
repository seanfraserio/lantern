
export function declaredTargets(manifest) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
  };
  for (const field of ['main', 'module', 'types']) add(manifest[field]);
  if (typeof manifest.bin === 'string') add(manifest.bin);
  else for (const value of Object.values(manifest.bin ?? {})) add(value);
  const walk = (value) => {
    if (typeof value === 'string' && value.startsWith('./')) add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest.exports);
  return [...targets];
}

export function checkArtifact(manifest, files) {
  const errors = [];
  for (const target of declaredTargets(manifest)) {
    if (target.includes('*')) {
      errors.push(`Wildcard entry requires an explicit consumer fixture: ${target}`);
    } else if (!files.has(target)) errors.push(`Missing declared entry: ${target}`);
    else if (target.startsWith('src/') || /\.tsx?$/.test(target) && !/\.d\.[cm]?ts$/.test(target)) {
      errors.push(`Entry points at uncompiled source: ${target}`);
    }
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace:|file:|link:)/.test(version)) errors.push(`Unresolved ${field}: ${name} ${version}`);
    }
  }
  return errors;
}


