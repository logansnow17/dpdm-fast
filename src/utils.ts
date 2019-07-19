/*!
 * Copyright 2019 acrazing <joking.young@gmail.com>. All rights reserved.
 * @since 2019-07-17 18:45:32
 */

import chalk from 'chalk';
import fs from 'fs-extra';
import G from 'glob';
import path from 'path';
import util from 'util';
import { Dependency, DependencyTree, ParseOptions } from './types';

export const glob = util.promisify(G);

export const defaultOptions: ParseOptions = {
  context: process.cwd(),
  extensions: ['', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
  include: /\.m?[tj]sx?$/,
  exclude: /\/node_modules\//,
};

export function normalizeOptions(options: Partial<ParseOptions>): ParseOptions {
  const newOptions = { ...defaultOptions, ...options };
  if (newOptions.extensions.indexOf('') < 0) {
    newOptions.extensions.unshift('');
  }
  return newOptions;
}

export async function appendSuffix(
  request: string,
  extensions: string[],
): Promise<string | null> {
  for (const ext of extensions) {
    try {
      const stat = await fs.stat(request + ext);
      if (stat.isFile()) {
        return request + ext;
      }
    } catch {}
  }
  try {
    const stat = await fs.stat(request);
    if (stat.isDirectory()) {
      return appendSuffix(path.join(request, 'index'), extensions);
    }
  } catch {}
  return null;
}

export async function resolve(
  context: string,
  request: string,
  extensions: string[],
) {
  if (path.isAbsolute(request)) {
    return appendSuffix(request, extensions);
  }
  if (request.charAt(0) === '.') {
    return appendSuffix(path.join(context, request), extensions);
  }
  // is package
  const nodePath = { paths: [context] };
  try {
    const pkgPath = require.resolve(
      path.join(request, 'package.json'),
      nodePath,
    );
    const pkgJson = await fs.readJSON(pkgPath);
    return path.join(path.dirname(pkgPath), pkgJson.module || pkgJson.main);
  } catch {}
  try {
    return require.resolve(request, nodePath);
  } catch {}
  return null;
}

export function shortenTree(
  context: string,
  tree: DependencyTree,
): DependencyTree {
  const output: DependencyTree = {};
  for (const key in tree) {
    const shortKey = path.relative(context, key);
    output[shortKey] = tree[key]
      ? tree[key]!.map(
          (item) =>
            ({
              ...item,
              issuer: shortKey,
              id: item.id === null ? null : path.relative(context, item.id),
            } as Dependency),
        )
      : null;
  }
  return output;
}

export function parseCircular(tree: DependencyTree): string[][] {
  const circulars: string[][] = [];

  tree = { ...tree };

  function visit(id: string, used: string[]) {
    const index = used.indexOf(id);
    if (index > -1) {
      circulars.push(used.slice(index));
    } else if (tree[id]) {
      used.push(id);
      const deps = tree[id];
      delete tree[id];
      deps &&
        deps.forEach((dep) => {
          dep.id && visit(dep.id, used.slice());
        });
    }
  }

  for (const id in tree) {
    visit(id, []);
  }
  return circulars;
}

export function parseDependents(
  tree: DependencyTree,
): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const key in tree) {
    const deps = tree[key];
    if (deps) {
      deps.forEach((dep) => {
        if (dep.id) {
          (output[dep.id] = output[dep.id] || []).push(key);
        }
      });
    }
  }
  for (const key in output) {
    output[key].sort();
  }
  return output;
}

export function parseWarnings(
  tree: DependencyTree,
  dependents = parseDependents(tree),
): string[] {
  const warnings: string[] = [];
  const builtin = new Set<string>();
  for (const key in tree) {
    const deps = tree[key];
    if (!deps) {
      if (!builtin.has(key)) {
        try {
          if (require.resolve(key) === key) {
            builtin.add(key);
            continue;
          }
        } catch {}
      }
      const parents = dependents[key] || [];
      const total = parents.length;
      warnings.push(
        `skip ${JSON.stringify(key)}, issuers: ${parents
          .slice(0, 2)
          .map((id) => JSON.stringify(id))
          .join(', ')}${total > 2 ? ` (${total - 2} more...)` : ''}`,
      );
    } else {
      for (const dep of deps) {
        if (!dep.id) {
          warnings.push(
            `lose ${JSON.stringify(dep.request)} from ${JSON.stringify(
              dep.issuer,
            )}`,
          );
        }
      }
    }
  }
  if (builtin.size > 0) {
    warnings.push(
      'node ' + Array.from(builtin, (item) => JSON.stringify(item)).join(', '),
    );
  }
  return warnings.sort();
}

export function prettyTree(
  tree: DependencyTree,
  entries: string[],
  prefix = '  ',
) {
  const lines: string[] = [];
  let id = 0;
  const idMap: Record<string, number> = {};
  const digits = Math.ceil(Math.log10(Object.keys(tree).length));

  function visit(item: string, prefix: string, hasMore: boolean) {
    const isNew = idMap[item] === void 0;
    const iid = (idMap[item] = idMap[item] || id++);
    let line = chalk.dim(
      prefix + '- ' + iid.toString().padStart(digits, '0') + ') ',
    );
    const deps = tree[item];
    if (!isNew) {
      lines.push(line + chalk.dim(item));
      return;
    } else if (!deps) {
      lines.push(line + chalk.yellowBright(item));
      return;
    }
    lines.push(line + chalk.whiteBright(item));
    prefix += hasMore ? '·   ' : '    ';
    for (let i = 0; i < deps.length; i++) {
      visit(deps[i].id || deps[i].request, prefix, i < deps.length - 1);
    }
  }

  for (let i = 0; i < entries.length; i++) {
    visit(entries[i], prefix, i < entries.length - 1);
  }

  return lines.join('\n');
}

export function prettyCircular(circulars: string[][], prefix = '  ') {
  const digits = Math.ceil(Math.log10(circulars.length));
  return circulars
    .map((line, index) => {
      return (
        chalk.dim(
          `${prefix}${(index + 1).toString().padStart(digits, '0')}) `,
        ) + line.map((item) => chalk.cyanBright(item)).join(chalk.dim(' -> '))
      );
    })
    .join('\n');
}

export function prettyWarning(warnings: string[], prefix = '  ') {
  const digits = Math.ceil(Math.log10(warnings.length));
  return warnings
    .map((line, index) => {
      return (
        chalk.dim(
          `${prefix}${(index + 1).toString().padStart(digits, '0')}) `,
        ) + chalk.yellowBright(line)
      );
    })
    .join('\n');
}
