// Git helper script to save all changes into the "draft" branch.
// Uses git worktree to avoid branch switching and stash — eliminates conflicts.

import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const { $ } = Bun;

const DRAFT_BRANCH = 'draft';

// Workaround for NixOS/Home Manager read-only SSH config permission errors.
if (!process.env.GIT_SSH_COMMAND) {
    process.env.GIT_SSH_COMMAND = 'ssh -F /dev/null';
}

/** Check if the working tree has uncommitted changes. */
async function hasChanges(): Promise<boolean> {
    const status = (await $`git status --porcelain`.quiet().text()).trim();
    return status.length > 0;
}

/** Create the draft branch if it does not exist yet. */
async function ensureDraftBranchExists(): Promise<void> {
    const result = await $`git rev-parse --verify ${DRAFT_BRANCH}`.quiet().nothrow();
    if (!result.exitCode) {
        return;
    }
    await $`git branch ${DRAFT_BRANCH}`.quiet();
}

/** Generate a timestamp string for the commit message (YYYY-MM-DD-HH-MM-SS). */
function generateTimestamp(): string {
    return new Date()
        .toISOString()
        .replace(/T/, '-')
        .replace(/\..+/, '')
        .replace(/:/g, '-');
}

/**
 * Create a git command runner for the worktree with hooks disabled.
 * Returns Bun's $ tagged template bound to the worktree directory,
 * with core.hooksPath=/dev/null to prevent hook failures.
 */
function wt(worktreePath: string) {
    const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
    return {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        $: (strings: TemplateStringsArray, ...values: any[]) =>
            Bun.$(strings, ...values).cwd(worktreePath).env(env).quiet(),
    };
}

/** Save current working tree changes to the draft branch via a temporary worktree. */
async function main(): Promise<void> {
    if (!await hasChanges()) {
        return;
    }

    await ensureDraftBranchExists();

    // Prune stale worktree entries (e.g. from interrupted previous runs).
    await $`git worktree prune`.quiet();

    // Create a temporary worktree for the draft branch.
    const worktreePath = join(tmpdir(), `draft-save-${Date.now()}`);
    try {
        // --no-checkout avoids triggering git hooks (e.g. Trunk post-checkout).
        // We overwrite all files with rsync anyway.
        await $`git worktree add --no-checkout ${worktreePath} ${DRAFT_BRANCH}`.quiet();

        // Get the root of the current working tree (handles being run from subdirs).
        const repoRoot = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();

        // Copy ALL files from the current working tree to the worktree.
        await $`rsync --archive --delete --exclude=.git ${repoRoot}/ ${worktreePath}/`.quiet();

        // Stage and commit inside the worktree with hooks disabled.
        const { $: g } = wt(worktreePath);
        await g`git add -A`;

        const status = (await g`git status --porcelain`.text()).trim();
        if (!status.length) {
            return;
        }

        const timestamp = generateTimestamp();
        await g`git commit -m ${'draft-' + timestamp}`;

        // Force push — draft branch always mirrors the current working tree exactly.
        await g`git push --force-with-lease -u origin ${DRAFT_BRANCH}`;
    } finally {
        if (existsSync(worktreePath)) {
            await $`git worktree remove --force ${worktreePath}`.quiet().nothrow();
        }
    }
}

main().catch((err) => {
    console.error('Save failed:', err.message);
    process.exitCode = 1;
});
