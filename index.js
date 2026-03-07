/**
 * ESLint plugin: default-export-named
 *
 * Enforces bidirectional consistency between named exports and default object export:
 *
 * 1. If a file has `export default { a, b }`, every property must also be a named export.
 * 2. If a file has runtime named exports (class, function, const — not type/interface/re-export),
 *    it must have `export default { ... }` containing all of them.
 *
 * Type-only exports (export type, export interface) and re-exports (export { X } from '...')
 * are excluded because they cannot appear in a runtime object literal.
 */

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
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

/** @type {import('eslint').ESLint.Plugin} */
export default {
    rules: {
        'default-export-named': rule,
    },
};
