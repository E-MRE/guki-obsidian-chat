import { readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const targetVersion = process.env.npm_package_version || process.argv[2] || pkg.version;

if (!targetVersion || typeof targetVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(-.+)?$/.test(targetVersion)) {
	throw new Error(`Invalid or missing target version: "${targetVersion}"`);
}

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
if (!minAppVersion) {
	throw new Error('manifest.json is missing required minAppVersion field');
}
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
}
