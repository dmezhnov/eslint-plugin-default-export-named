// Publish a new version to npmjs.com via GitHub Actions.
//
// Usage:
//   mise run publish            # interactive: choose patch/minor/major
//   mise run publish -- 0.1.0   # publish exact version

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import process from 'node:process';

const { $ } = Bun;

// Workaround for NixOS/Home Manager read-only SSH config permission errors.
if (!process.env.GIT_SSH_COMMAND) {
    process.env.GIT_SSH_COMMAND = 'ssh -F /dev/null';
}

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
    // Save any uncommitted changes to draft first
    const status = (await $`git status --porcelain`.quiet().text()).trim();
    if (status) {
        console.log('Saving uncommitted changes to draft...');
        await $`mise run save`;
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

    const tag = `v${newVersion}`;

    // Check if tag already exists before making any changes
    const existingTags = (await $`git tag -l ${tag}`.quiet().text()).trim();
    if (existingTags) {
        throw new Error(`Tag ${tag} already exists. Delete it first or choose a different version.`);
    }

    pkg.version = newVersion;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');

    console.log(`\n${oldVersion} → ${newVersion}`);

    // Commit version bump, tag, and push to main
    await $`git add package.json`.quiet();
    await $`git commit -m ${tag}`.quiet();
    await $`git tag ${tag}`;
    await $`git push origin HEAD:main ${tag}`;

    console.log(`\nGitHub Actions will publish ${tag} to npmjs.com.`);
}

main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
});
