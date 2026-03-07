// Publish a new version to GitHub Packages.
//
// Usage:
//   mise run publish            # interactive: choose patch/minor/major
//   mise run publish -- 0.1.0   # publish exact version

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const { $ } = Bun;

function bumpVersion(current: string, type: 'patch' | 'minor' | 'major'): string {
    const [major, minor, patch] = current.split('.').map(Number) as [number, number, number];
    switch (type) {
        case 'major': return `${major + 1}.0.0`;
        case 'minor': return `${major}.${minor + 1}.0`;
        case 'patch': return `${major}.${minor}.${patch + 1}`;
    }
}

async function prompt(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function chooseVersion(current: string): Promise<string> {
    const patch = bumpVersion(current, 'patch');
    const minor = bumpVersion(current, 'minor');
    const major = bumpVersion(current, 'major');

    console.log(`Current version: ${current}\n`);
    console.log(`  1) patch → ${patch}`);
    console.log(`  2) minor → ${minor}`);
    console.log(`  3) major → ${major}`);
    console.log('');

    const answer = await prompt('Choose (1/2/3): ');

    switch (answer) {
        case '1': return patch;
        case '2': return minor;
        case '3': return major;
        default: throw new Error(`Invalid choice: "${answer}"`);
    }
}

async function main(): Promise<void> {
    // Check for uncommitted changes
    const status = (await $`git status --porcelain`.quiet().text()).trim();
    if (status) {
        throw new Error('Working tree is dirty. Commit or stash changes first.');
    }

    // Read current version
    const pkgPath = resolve(import.meta.dir, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const oldVersion: string = pkg.version;

    // Determine new version
    const arg = process.argv[2];
    const newVersion = arg
        ? (/^\d+\.\d+\.\d+$/.test(arg) ? arg : (() => { throw new Error(`Invalid version: "${arg}". Use x.y.z format.`); })())
        : await chooseVersion(oldVersion);

    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');

    const tag = `v${newVersion}`;
    console.log(`\n${oldVersion} → ${newVersion}`);

    // Commit, tag, push
    await $`git add package.json`.quiet();
    await $`git commit -m ${tag}`.quiet();
    await $`git tag ${tag}`;
    await $`git push origin main ${tag}`;

    console.log(`\nGitHub Actions will publish ${tag} to npm.`);
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
