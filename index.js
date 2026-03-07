/**
 * ESLint plugin: default-export-named
 *
 * Rules:
 * 1. default-export-named — Enforces bidirectional consistency between named exports
 *    and default object export.
 * 2. require-barrel-index — Enforces that every directory has an index.ts barrel file
 *    re-exporting all sibling modules with names matching file names.
 */

import { readdirSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';

// ─── Rule: default-export-named ─────────────────────────────────────────────

/** @type {import('eslint').Rule.RuleModule} */
export const defaultExportNamedRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Enforce consistency between named exports and default object export',
        },
        messages: {
            missingNamedExport:
                '"{{ name }}" is in the default export but is not a named export.',
            missingDefaultExport:
                'File has named exports but no `export default { ... }` containing them.',
            missingInDefault:
                '"{{ name }}" is a named export but is not included in the default export object.',
            defaultNotObject:
                'File has named exports — default export must be an object literal `export default { ... }`, not a single value.',
        },
        schema: [],
    },
    create(context) {
        const namedExports = new Map(); // name → AST node
        let defaultExportNode = null;
        let defaultExportProperties = []; // [{ name, node }]
        let hasDefaultExport = false;
        let defaultIsObject = false;

        return {
            ExportNamedDeclaration(node) {
                // Skip re-exports: export { X } from '...'
                if (node.source) {
                    return;
                }

                // Skip type-only exports: export type { ... }
                if (node.exportKind === 'type') {
                    return;
                }

                if (node.declaration) {
                    // Skip: export type Foo = ... / export interface Foo { ... }
                    const declType = node.declaration.type;
                    if (declType === 'TSTypeAliasDeclaration' || declType === 'TSInterfaceDeclaration') {
                        return;
                    }

                    // export class Foo {} / export function bar() {}
                    if (node.declaration.id) {
                        namedExports.set(node.declaration.id.name, node);
                    }
                    // export const a = ..., b = ...
                    if (node.declaration.declarations) {
                        for (const decl of node.declaration.declarations) {
                            if (decl.id?.name) {
                                namedExports.set(decl.id.name, node);
                            }
                        }
                    }
                }

                // export { a, b } (without 'from')
                if (node.specifiers) {
                    for (const spec of node.specifiers) {
                        // Skip type-only specifiers: export { type Foo }
                        if (spec.exportKind === 'type') {
                            continue;
                        }
                        const name = spec.exported.type === 'Identifier'
                            ? spec.exported.name
                            : spec.exported.value;
                        namedExports.set(name, spec);
                    }
                }
            },

            ExportDefaultDeclaration(node) {
                hasDefaultExport = true;
                if (node.declaration.type === 'ObjectExpression') {
                    defaultIsObject = true;
                    defaultExportNode = node;
                    defaultExportProperties = node.declaration.properties
                        .filter(p => p.type === 'Property' && p.key?.type === 'Identifier')
                        .map(p => ({ name: p.key.name, node: p }));
                }
            },

            'Program:exit'() {
                // Direction 1: every property in default { ... } must be a named export
                if (defaultExportNode && defaultExportProperties.length > 0) {
                    for (const { name, node } of defaultExportProperties) {
                        if (!namedExports.has(name)) {
                            context.report({
                                node,
                                messageId: 'missingNamedExport',
                                data: { name },
                            });
                        }
                    }
                }

                // Direction 2: if there are runtime named exports, default must be an object containing them
                if (namedExports.size === 0) {
                    return;
                }

                if (!hasDefaultExport) {
                    // Report on the first named export node
                    const firstNode = namedExports.values().next().value;
                    context.report({
                        node: firstNode,
                        messageId: 'missingDefaultExport',
                    });
                    return;
                }

                if (!defaultIsObject) {
                    context.report({
                        node: defaultExportNode ?? context.sourceCode.ast,
                        messageId: 'defaultNotObject',
                    });
                    return;
                }

                // Check that every named export is in the default object
                const defaultNames = new Set(defaultExportProperties.map(p => p.name));
                for (const [name, node] of namedExports) {
                    if (!defaultNames.has(name)) {
                        context.report({
                            node,
                            messageId: 'missingInDefault',
                            data: { name },
                        });
                    }
                }
            },
        };
    },
};

// Keep backward-compatible alias
export const rule = defaultExportNamedRule;

// ─── Rule: require-barrel-index ─────────────────────────────────────────────

const DEFAULT_IGNORE = ['node_modules', '.git', '.trunk', '.github', '.claude'];

// Module-level cache: directories already reported for missingIndex
const checkedDirs = new Set();

/**
 * Strip file extension to get the import source path (without .ts/.js).
 * Examples: "Foo.bun.ts" → "Foo.bun", "Bar.ts" → "Bar", "baz.js" → "baz"
 */
function stripTsJsExt(filename) {
    return filename.replace(/\.[tj]sx?$/, '');
}

/**
 * Strip all extensions to get the export name.
 * Examples: "Foo.bun.ts" → "Foo", "Bar.ts" → "Bar", "baz.js" → "baz"
 */
function fileToExportName(filename) {
    return filename.replace(/\.bun\.[tj]sx?$/, '').replace(/\.[tj]sx?$/, '');
}

/**
 * Check if a filename is an index file.
 */
function isIndexFile(filename) {
    return /^index\.[tj]sx?$/.test(filename);
}

/**
 * Check if a filename is a source file we care about (not .d.ts, not test).
 */
function isSourceFile(filename) {
    if (/\.d\.[tj]s$/.test(filename)) {
        return false;
    }
    if (/\.(test|spec)\.[tj]sx?$/.test(filename)) {
        return false;
    }
    return /\.[tj]sx?$/.test(filename);
}

/** @type {import('eslint').Rule.RuleModule} */
export const requireBarrelIndexRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Enforce that every directory has an index.ts barrel file re-exporting all sibling modules',
        },
        messages: {
            missingIndex:
                'Directory has source files but no index.ts barrel file.',
            missingReExport:
                '"{{ name }}" is not re-exported from index.',
            wrongExportName:
                '"{{ file }}" should be re-exported as "{{ expected }}", not "{{ actual }}".',
        },
        schema: [{
            type: 'object',
            properties: {
                ignore: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Directory names to ignore',
                },
            },
            additionalProperties: false,
        }],
    },
    create(context) {
        const options = context.options[0] || {};
        const ignoreDirs = new Set([...DEFAULT_IGNORE, ...(options.ignore || [])]);

        const filePath = context.filename || context.getFilename();
        if (!filePath || filePath === '<input>' || filePath === '<text>') {
            return {};
        }

        const dir = dirname(resolve(filePath));
        const currentFileName = basename(filePath);
        const isCurrentIndex = isIndexFile(currentFileName);

        // Check if any ancestor directory is ignored
        const dirParts = dir.split('/');
        for (const part of dirParts) {
            if (ignoreDirs.has(part)) {
                return {};
            }
        }

        // Collect re-exports only when processing the index file
        const reExports = new Map(); // source path (e.g. './Foo.bun') → { exportedName, node }

        return {
            ExportNamedDeclaration(node) {
                if (!isCurrentIndex || !node.source) {
                    return;
                }
                const sourcePath = node.source.value;
                for (const spec of (node.specifiers || [])) {
                    const exportedName = spec.exported.type === 'Identifier'
                        ? spec.exported.name
                        : spec.exported.value;
                    reExports.set(sourcePath, { exportedName, node });
                }
            },

            ExportAllDeclaration(node) {
                if (!isCurrentIndex || !node.source) {
                    return;
                }
                // export * from './Foo.bun' — counts as a re-export (name check skipped)
                reExports.set(node.source.value, { exportedName: null, node });
            },

            'Program:exit'(programNode) {
                let siblings;
                try {
                    siblings = readdirSync(dir)
                        .filter(f => isSourceFile(f) && !isIndexFile(f));
                } catch {
                    return;
                }

                if (siblings.length === 0) {
                    return;
                }

                // Check 1: does index exist?
                const hasIndex = existsSync(join(dir, 'index.ts')) || existsSync(join(dir, 'index.js'));

                if (!hasIndex) {
                    if (!checkedDirs.has(dir)) {
                        checkedDirs.add(dir);
                        context.report({
                            node: programNode,
                            messageId: 'missingIndex',
                        });
                    }
                    return;
                }

                // Check 2 & 3: only when we are processing the index file
                if (!isCurrentIndex) {
                    return;
                }

                // Build set of re-exported source paths
                const reExportedSources = new Set(reExports.keys());

                for (const siblingFile of siblings) {
                    const expectedSource = './' + stripTsJsExt(siblingFile);
                    const expectedName = fileToExportName(siblingFile);

                    if (!reExportedSources.has(expectedSource)) {
                        context.report({
                            node: programNode,
                            messageId: 'missingReExport',
                            data: { name: expectedName },
                        });
                        continue;
                    }

                    // Check export name matches file name
                    const reExport = reExports.get(expectedSource);
                    if (reExport.exportedName !== null && reExport.exportedName !== expectedName) {
                        context.report({
                            node: reExport.node,
                            messageId: 'wrongExportName',
                            data: {
                                file: siblingFile,
                                expected: expectedName,
                                actual: reExport.exportedName,
                            },
                        });
                    }
                }
            },
        };
    },
};

// ─── Plugin export ──────────────────────────────────────────────────────────

/** @type {import('eslint').ESLint.Plugin} */
export default {
    rules: {
        'default-export-named': defaultExportNamedRule,
        'require-barrel-index': requireBarrelIndexRule,
    },
};
