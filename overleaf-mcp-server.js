#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { readFile, writeFile, access, readdir } from 'fs/promises';
import { promisify } from 'util';
import { exec as execCallback, execFile as execFileCallback } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const exec = promisify(execCallback);
const execFileP = promisify(execFileCallback);

// Strip the Overleaf git token from any string that may leak into errors/output
const maskToken = (s) =>
  String(s ?? '').replace(/(https?:\/\/)git:[^@\s]+@/g, '$1git:***@');

// Pure parser for LaTeX sectioning commands. Brace-balanced so titles with
// nested macros (e.g. \section{Use of \emph{X}}) are captured correctly.
// Handles \part, \chapter, \section, \subsection, \subsubsection plus their
// starred variants and optional [short]{long} short-title form.
function parseSections(content) {
  const sections = [];
  const openerRegex = /\\(subsubsection|subsection|section|chapter|part)\*?(?:\[[^\]]*\])?\{/g;
  let m;
  while ((m = openerRegex.exec(content)) !== null) {
    const startIdx = m.index;
    let depth = 1;
    let i = openerRegex.lastIndex;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '\\') { i += 2; continue; } // skip escaped char
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) break;
      i++;
    }
    if (depth !== 0) continue; // unclosed brace, skip
    sections.push({
      title: content.slice(openerRegex.lastIndex, i),
      type: m[1],
      index: startIdx,
    });
    openerRegex.lastIndex = i + 1;
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Configuration loading
//
// Priority (first match wins):
//   1. OVERLEAF_PROJECT_ID + (OVERLEAF_GIT_TOKEN | OVERLEAF_GIT_TOKEN_FILE)
//      → synthesize a single-project config under the key `default`.
//      OVERLEAF_PROJECT_NAME is optional and only sets the display name.
//      OVERLEAF_SERVER_URL is optional and points at a self-hosted Overleaf
//      instance (e.g. https://latex.example.edu); omit it for overleaf.com.
//   2. OVERLEAF_PROJECTS_CONFIG=/path/to/projects.json
//   3. <user config dir>/overleaf-mcp/projects.json
//        - Windows: %APPDATA%/overleaf-mcp/projects.json
//        - Other:   $XDG_CONFIG_HOME/overleaf-mcp/projects.json
//                   (falls back to ~/.config/overleaf-mcp/projects.json)
//   4. $CWD/projects.json
//   5. <package dir>/projects.json   (legacy, for clone-based installs)
//
// All diagnostics go to stderr only — stdout is owned by the MCP stdio
// transport and any stray write would corrupt the JSON-RPC stream.
// ---------------------------------------------------------------------------

function userConfigCandidate() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'overleaf-mcp', 'projects.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'overleaf-mcp', 'projects.json');
}

async function readEnvToken() {
  const direct = process.env.OVERLEAF_GIT_TOKEN?.trim();
  if (direct) return { token: direct, source: 'OVERLEAF_GIT_TOKEN' };
  const tokenFile = process.env.OVERLEAF_GIT_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      const raw = await readFile(tokenFile, 'utf-8');
      return { token: raw.trim(), source: `OVERLEAF_GIT_TOKEN_FILE (${tokenFile})` };
    } catch (err) {
      console.error(
        `[overleaf-mcp] OVERLEAF_GIT_TOKEN_FILE="${tokenFile}" could not be read: ${err.message}`
      );
    }
  }
  return null;
}

function validateProject(project, sourceLabel) {
  if (!project.projectId || /\s/.test(project.projectId)) {
    console.error(
      `[overleaf-mcp] FATAL: projectId from ${sourceLabel} is empty or contains whitespace ` +
        `(got ${JSON.stringify(project.projectId)}). The projectId is used as a path component ` +
        `and a Git URL — fix it before retrying.`
    );
    process.exit(1);
  }
  if (!project.gitToken || /\s/.test(project.gitToken)) {
    console.error(
      `[overleaf-mcp] Warning: gitToken from ${sourceLabel} is empty or has internal whitespace ` +
        `(file-based tokens often carry a trailing newline; trying anyway)`
    );
  }
}

// Normalize a user-supplied server URL down to its origin (scheme + host +
// port). Returns null when unset. Self-hosted Overleaf instances are addressed
// by origin only — a path or embedded credentials are a configuration error.
function normalizeServerUrl(raw, sourceLabel) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    console.error(
      `[overleaf-mcp] FATAL: serverUrl from ${sourceLabel} is not a valid URL ` +
        `(got ${JSON.stringify(trimmed)}). Use an origin like https://latex.example.edu`
    );
    process.exit(1);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.error(
      `[overleaf-mcp] FATAL: serverUrl from ${sourceLabel} must use http(s) ` +
        `(got ${JSON.stringify(trimmed)}).`
    );
    process.exit(1);
  }
  if (parsed.username || parsed.password) {
    console.error(
      `[overleaf-mcp] FATAL: serverUrl from ${sourceLabel} must not contain credentials ` +
        `— the git token is supplied separately via gitToken / OVERLEAF_GIT_TOKEN.`
    );
    process.exit(1);
  }
  if (/\s/.test(trimmed)) {
    console.error(
      `[overleaf-mcp] FATAL: serverUrl from ${sourceLabel} contains whitespace ` +
        `(got ${JSON.stringify(trimmed)}).`
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:') {
    console.error(
      `[overleaf-mcp] Warning: serverUrl from ${sourceLabel} uses plain http — ` +
        `the git token will be transmitted unencrypted.`
    );
  }
  return parsed.origin;
}

async function tryLoadFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadExplicitConfigOrExit(filePath, sourceLabel) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    console.error(`[overleaf-mcp] FATAL: ${sourceLabel}="${filePath}" could not be read: ${err.message}`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[overleaf-mcp] FATAL: ${sourceLabel}="${filePath}" is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function validateConfigShape(data, sourceLabel) {
  if (!data?.projects || typeof data.projects !== 'object') {
    console.error(
      `[overleaf-mcp] FATAL: config from ${sourceLabel} is missing the top-level "projects" object.`
    );
    process.exit(1);
  }
  const projects = {};
  for (const [key, p] of Object.entries(data.projects)) {
    const label = `${sourceLabel} → projects.${key}`;
    validateProject(p, label);
    projects[key] = { ...p, serverUrl: normalizeServerUrl(p.serverUrl, label) };
  }
  return { ...data, projects };
}

async function loadProjectsConfig() {
  // 1. Env-var single-project mode wins outright.
  const envId = process.env.OVERLEAF_PROJECT_ID?.trim();
  const envTok = await readEnvToken();
  if (envId && envTok) {
    // Note any shadowed file so the user can spot misconfiguration at a glance.
    const shadowCandidates = [];
    if (process.env.OVERLEAF_PROJECTS_CONFIG) {
      shadowCandidates.push({ label: 'OVERLEAF_PROJECTS_CONFIG', path: process.env.OVERLEAF_PROJECTS_CONFIG });
    }
    shadowCandidates.push({ label: 'user config', path: userConfigCandidate() });
    shadowCandidates.push({ label: 'cwd', path: path.join(process.cwd(), 'projects.json') });
    shadowCandidates.push({ label: 'package dir', path: path.join(__dirname, 'projects.json') });
    let shadow = null;
    for (const c of shadowCandidates) {
      const data = await tryLoadFile(c.path);
      if (data) { shadow = c; break; }
    }
    if (shadow) {
      console.error(
        `[overleaf-mcp] Using env vars (OVERLEAF_PROJECT_ID + ${envTok.source}). ` +
          `Also found projects.json at ${shadow.path} — env vars take priority.`
      );
    }
    const project = {
      name: process.env.OVERLEAF_PROJECT_NAME?.trim() || 'Overleaf Project',
      projectId: envId,
      gitToken: envTok.token,
      serverUrl: normalizeServerUrl(process.env.OVERLEAF_SERVER_URL, 'OVERLEAF_SERVER_URL'),
    };
    validateProject(project, 'env vars');
    return { projects: { default: project } };
  }

  // 2. Explicit OVERLEAF_PROJECTS_CONFIG — must be readable; no silent fallthrough.
  if (process.env.OVERLEAF_PROJECTS_CONFIG) {
    const p = process.env.OVERLEAF_PROJECTS_CONFIG;
    const data = await loadExplicitConfigOrExit(p, 'OVERLEAF_PROJECTS_CONFIG');
    return validateConfigShape(data, `OVERLEAF_PROJECTS_CONFIG (${p})`);
  }

  // 3. Implicit fallback chain — first match wins, missing files are not an error.
  const fallbackCandidates = [
    { label: 'user config', path: userConfigCandidate() },
    { label: 'cwd', path: path.join(process.cwd(), 'projects.json') },
    { label: 'package dir', path: path.join(__dirname, 'projects.json') },
  ];
  for (const c of fallbackCandidates) {
    const data = await tryLoadFile(c.path);
    if (data) return validateConfigShape(data, `${c.label} (${c.path})`);
  }

  // 4. Nothing found — print actionable help and exit.
  console.error('[overleaf-mcp] No configuration found. Set one of:');
  console.error('  - OVERLEAF_PROJECT_ID + OVERLEAF_GIT_TOKEN          (single-project, recommended)');
  console.error('  - OVERLEAF_PROJECT_ID + OVERLEAF_GIT_TOKEN_FILE     (token loaded from a file)');
  console.error('  - OVERLEAF_PROJECTS_CONFIG=/path/to/projects.json   (multi-project)');
  console.error('  Or place projects.json at one of:');
  const seen = new Set();
  for (const c of fallbackCandidates) {
    const resolved = path.resolve(c.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    console.error(`      ${c.path}`);
  }
  process.exit(1);
}

const projectsConfig = await loadProjectsConfig();

// Git operations helper
class OverleafGitClient {
  constructor(project) {
    this.projectId = project.projectId;
    this.gitToken = project.gitToken;
    if (project.serverUrl) {
      // Self-hosted instance: git lives at <origin>/git/<projectId>.
      // The host is part of the local clone path so identical projectIds on
      // different servers never share a checkout.
      const { protocol, host } = new URL(project.serverUrl);
      const safeHost = host.replace(/[^A-Za-z0-9.-]/g, '_');
      this.repoPath = path.join(os.tmpdir(), `overleaf-${safeHost}-${this.projectId}`);
      this.cloneUrl = `${protocol}//git:${this.gitToken}@${host}/git/${this.projectId}`;
    } else {
      // Official overleaf.com: dedicated git host, historic clone path.
      this.repoPath = path.join(os.tmpdir(), `overleaf-${this.projectId}`);
      this.cloneUrl = `https://git:${this.gitToken}@git.overleaf.com/${this.projectId}`;
    }
  }

  // Resolve a caller-supplied path under the repo root, refusing traversal
  resolveSafePath(filePath) {
    const repoRoot = path.resolve(this.repoPath);
    const fullPath = path.resolve(repoRoot, filePath);
    if (fullPath !== repoRoot && !fullPath.startsWith(repoRoot + path.sep)) {
      throw new Error(`filePath "${filePath}" escapes the project directory`);
    }
    return fullPath;
  }

  async cloneOrPull() {
    try {
      await access(path.join(this.repoPath, '.git'));
      // .git folder exists, just pull
      const { stdout } = await exec(
        `cd "${this.repoPath}" && git pull`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      return stdout;
    } catch {
      // Not cloned yet, do initial clone
      const { stdout } = await exec(
        `git clone "${this.cloneUrl}" "${this.repoPath}"`,
        { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
      );
      // Set a local committer identity so `git commit` works even when global config is absent
      await execFileP('git', ['-C', this.repoPath, 'config', 'user.email', 'mcp@overleaf-mcp.local']);
      await execFileP('git', ['-C', this.repoPath, 'config', 'user.name', 'Overleaf MCP']);
      return stdout;
    }
  }

  async listFiles(extension = '.tex') {
    await this.cloneOrPull();
    // Recursive walk
    const results = [];
    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== '.git') {
          await walk(fullPath);
        } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
          results.push(path.relative(this.repoPath, fullPath));
        }
      }
    };
    await walk(this.repoPath);
    return results;
  }

  async readFile(filePath) {
    await this.cloneOrPull();
    const fullPath = this.resolveSafePath(filePath);
    return await readFile(fullPath, 'utf-8');
  }

  async getSections(filePath) {
    const content = await this.readFile(filePath);
    return parseSections(content);
  }

  async getSectionContent(filePath, sectionTitle) {
    // Single read + pure parse so the content and section indices come from the
    // same snapshot (no second pull mid-call).
    const content = await this.readFile(filePath);
    const sections = parseSections(content);

    const targetSection = sections.find(s => s.title === sectionTitle);
    if (!targetSection) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }

    const nextSection = sections.find(s => s.index > targetSection.index);
    const startIdx = targetSection.index;
    const endIdx = nextSection ? nextSection.index : content.length;

    return content.substring(startIdx, endIdx);
  }

  async writeSection(filePath, sectionTitle, newContent, commitMessage) {
    try {
      await this.cloneOrPull();
    } catch (err) {
      if (err.message.includes('CONFLICT')) {
        throw new Error(`Merge conflict while pulling. Resolve the conflict in Overleaf, then retry.`);
      }
      throw err;
    }
    const fullPath = this.resolveSafePath(filePath);
    const fileContent = await readFile(fullPath, 'utf-8');
    // Parse from the same snapshot we are about to splice into — avoids a
    // TOCTOU race where a second pull would shift section offsets.
    const sections = parseSections(fileContent);

    const target = sections.find(s => s.title === sectionTitle);
    if (!target) {
      throw new Error(`Section "${sectionTitle}" not found`);
    }

    // Find where the next same-or-higher level section starts, or end of document
    const sectionLevels = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };
    const targetLevel = sectionLevels[target.type] ?? 99;
    const next = sections.find(s => s.index > target.index && (sectionLevels[s.type] ?? 99) <= targetLevel);
    const endMarker = fileContent.lastIndexOf('\\end{document}');
    const endIdx = next ? next.index : (endMarker === -1 ? fileContent.length : endMarker);

    const updated =
      fileContent.slice(0, target.index) +
      newContent.trimEnd() + '\n\n' +
      fileContent.slice(endIdx);

    await writeFile(fullPath, updated, 'utf-8');
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      await execFileP('git', ['-C', this.repoPath, 'add', '--', filePath], { env });
      await execFileP('git', ['-C', this.repoPath, 'commit', '-m', commitMessage], { env });
      const { stdout } = await execFileP('git', ['-C', this.repoPath, 'push'], { env });
      return stdout;
    } catch (err) {
      if (err.message.includes('non-fast-forward') || err.message.includes('rejected')) {
        throw new Error(`Push rejected, remote has new changes. Retry to pull and re-apply your write.`);
      }
      throw err;
    }
  }

  async writeFile(filePath, content, commitMessage) {
    try {
      // Pull before writing to avoid conflicts with remote changes
      await this.cloneOrPull();
    } catch (err) {
      if (err.message.includes('CONFLICT')) {
        throw new Error(
          `Merge conflict while pulling. Resolve the conflict in Overleaf, then retry.`
        );
      }
      throw err;
    }
    const fullPath = this.resolveSafePath(filePath);
    await writeFile(fullPath, content, 'utf-8');
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      await execFileP('git', ['-C', this.repoPath, 'add', '--', filePath], { env });
      await execFileP('git', ['-C', this.repoPath, 'commit', '-m', commitMessage], { env });
      const { stdout } = await execFileP('git', ['-C', this.repoPath, 'push'], { env });
      return stdout;
    } catch (err) {
      if (err.message.includes('non-fast-forward') || err.message.includes('rejected')) {
        throw new Error(
          `Push rejected, remote has new changes. Retry to pull and re-apply your write.`
        );
      }
      throw err;
    }
  }
}

// Create MCP server
const server = new Server(
  {
    name: 'overleaf-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Helper to get project
function getProject(projectName = 'default') {
  const project = Object.hasOwn(projectsConfig.projects, projectName)
    ? projectsConfig.projects[projectName]
    : undefined;
  if (!project) {
    throw new Error(`Project "${projectName}" not found in configuration`);
  }
  return new OverleafGitClient(project);
}

// Upper bound for a caller-supplied projectNamePattern — keeps regex cost
// predictable. Patterns only ever run against local config keys.
const MAX_PATTERN_LENGTH = 200;

// Shared schema description for the projectNamePattern property on read tools.
const PROJECT_NAME_PATTERN_DESCRIPTION =
  'Regex matched against configured project keys to operate on multiple projects at once ' +
  '(read tools only). Mutually exclusive with projectName. Matches are partial — anchor ' +
  'with ^...$ for exact keys. Results are returned as a JSON object keyed by project name.';

// Batch git operations against matched projects in chunks of this size, so a
// wide pattern cannot fire unbounded concurrent git processes (and hit
// Overleaf rate limits).
const BATCH_CONCURRENCY = 4;

// Compile a caller-supplied regex and match it against configured project
// keys. Overleaf's git API cannot enumerate an account's projects, so a
// pattern can only select among keys already present in the configuration.
// All errors are thrown before any git/network work, so they are testable
// without credentials.
function resolveProjectKeys(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('projectNamePattern must be a non-empty string');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`projectNamePattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  let re;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid projectNamePattern "${pattern}": ${err.message}`);
  }
  const keys = Object.keys(projectsConfig.projects);
  const matches = keys.filter(k => re.test(k));
  if (matches.length === 0) {
    throw new Error(
      `No configured project matches pattern "${pattern}" — available projects: ${keys.join(', ')}`
    );
  }
  return matches;
}

// Run fn(client, key) for every project matching args.projectNamePattern and
// return the grouped MCP response. Per-project failures are isolated into
// `{ error }` values and masked here — grouped errors land in the normal
// response body and never pass through the outer catch's maskToken.
async function runOnMatchedProjects(args, fn) {
  if (args.projectName && args.projectNamePattern) {
    throw new Error('projectName and projectNamePattern are mutually exclusive — pass one or the other');
  }
  const keys = resolveProjectKeys(args.projectNamePattern);
  const entries = [];
  for (let i = 0; i < keys.length; i += BATCH_CONCURRENCY) {
    const batch = await Promise.all(keys.slice(i, i + BATCH_CONCURRENCY).map(async (key) => {
      try {
        const client = new OverleafGitClient(projectsConfig.projects[key]);
        return [key, await fn(client, key)];
      } catch (err) {
        return [key, { error: maskToken(err?.message ?? String(err)) }];
      }
    }));
    entries.push(...batch);
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(Object.fromEntries(entries), null, 2),
      },
    ],
  };
}

// List all projects
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'list_projects',
        description: 'List all configured Overleaf projects',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'list_files',
        description: 'List files in an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Project identifier (optional, defaults to "default"). Mutually exclusive with projectNamePattern.',
            },
            projectNamePattern: {
              type: 'string',
              description: PROJECT_NAME_PATTERN_DESCRIPTION,
            },
            extension: {
              type: 'string',
              description: 'File extension filter (optional, e.g., ".tex")',
            },
          },
        },
      },
      {
        name: 'read_file',
        description: 'Read a file from an Overleaf project',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional). Mutually exclusive with projectNamePattern.',
            },
            projectNamePattern: {
              type: 'string',
              description: PROJECT_NAME_PATTERN_DESCRIPTION,
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_sections',
        description: 'Get all sections from a LaTeX file',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional). Mutually exclusive with projectNamePattern.',
            },
            projectNamePattern: {
              type: 'string',
              description: PROJECT_NAME_PATTERN_DESCRIPTION,
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'get_section_content',
        description: 'Get content of a specific section',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            sectionTitle: {
              type: 'string',
              description: 'Title of the section',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional). Mutually exclusive with projectNamePattern.',
            },
            projectNamePattern: {
              type: 'string',
              description: PROJECT_NAME_PATTERN_DESCRIPTION,
            },
          },
          required: ['filePath', 'sectionTitle'],
        },
      },
      {
        name: 'status_summary',
        description: 'Get a comprehensive project status summary',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: {
              type: 'string',
              description: 'Project identifier (optional). Mutually exclusive with projectNamePattern.',
            },
            projectNamePattern: {
              type: 'string',
              description: PROJECT_NAME_PATTERN_DESCRIPTION,
            },
          },
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file in an Overleaf project and push to Overleaf',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file',
            },
            content: {
              type: 'string',
              description: 'Full file content to write',
            },
            commitMessage: {
              type: 'string',
              description: 'Git commit message',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'content', 'commitMessage'],
        },
      },
      {
        name: 'write_section',
        description: 'Replace a single section in a LaTeX file and push to Overleaf. Safer than write_file for targeted edits — only the named section is replaced, leaving the rest of the file untouched.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the LaTeX file',
            },
            sectionTitle: {
              type: 'string',
              description: 'Title of the section to replace (must match exactly)',
            },
            newContent: {
              type: 'string',
              description: 'Full replacement content for the section, including the section heading',
            },
            commitMessage: {
              type: 'string',
              description: 'Git commit message',
            },
            projectName: {
              type: 'string',
              description: 'Project identifier (optional)',
            },
          },
          required: ['filePath', 'sectionTitle', 'newContent', 'commitMessage'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'list_projects': {
        const projects = Object.entries(projectsConfig.projects).map(([key, project]) => ({
          id: key,
          name: project.name,
          projectId: project.projectId,
          serverUrl: project.serverUrl || 'https://www.overleaf.com',
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      }

      case 'list_files': {
        if (args.projectNamePattern !== undefined) {
          return await runOnMatchedProjects(args, async (client) => ({
            files: await client.listFiles(args.extension || '.tex'),
          }));
        }
        const client = getProject(args.projectName);
        const files = await client.listFiles(args.extension || '.tex');
        return {
          content: [
            {
              type: 'text',
              text: files.join('\n'),
            },
          ],
        };
      }

      case 'read_file': {
        if (args.projectNamePattern !== undefined) {
          return await runOnMatchedProjects(args, async (client) => ({
            content: await client.readFile(args.filePath),
          }));
        }
        const client = getProject(args.projectName);
        const content = await client.readFile(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'get_sections': {
        if (args.projectNamePattern !== undefined) {
          return await runOnMatchedProjects(args, async (client) => ({
            sections: await client.getSections(args.filePath),
          }));
        }
        const client = getProject(args.projectName);
        const sections = await client.getSections(args.filePath);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sections, null, 2),
            },
          ],
        };
      }

      case 'get_section_content': {
        if (args.projectNamePattern !== undefined) {
          return await runOnMatchedProjects(args, async (client) => ({
            content: await client.getSectionContent(args.filePath, args.sectionTitle),
          }));
        }
        const client = getProject(args.projectName);
        const content = await client.getSectionContent(args.filePath, args.sectionTitle);
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      }

      case 'status_summary': {
        if (args.projectNamePattern !== undefined) {
          return await runOnMatchedProjects(args, async (client) => {
            const files = await client.listFiles();
            const mainFile = files.find(f => f.includes('main.tex')) || files[0];
            const sections = mainFile ? await client.getSections(mainFile) : [];
            return {
              totalFiles: files.length,
              mainFile,
              totalSections: sections.length,
              files: files.slice(0, 10),
            };
          });
        }
        const client = getProject(args.projectName);
        const files = await client.listFiles();
        const mainFile = files.find(f => f.includes('main.tex')) || files[0];
        let sections = [];

        if (mainFile) {
          sections = await client.getSections(mainFile);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                totalFiles: files.length,
                mainFile,
                totalSections: sections.length,
                files: files.slice(0, 10),
              }, null, 2),
            },
          ],
        };
      }

      case 'write_file': {
        if (args.projectNamePattern !== undefined) {
          throw new Error('projectNamePattern is not supported by write_file — pass projectName to write to exactly one project');
        }
        const client = getProject(args.projectName);
        const result = await client.writeFile(args.filePath, args.content, args.commitMessage);
        return {
          content: [
            {
              type: 'text',
              text: result || 'File written and pushed successfully.',
            },
          ],
        };
      }

      case 'write_section': {
        if (args.projectNamePattern !== undefined) {
          throw new Error('projectNamePattern is not supported by write_section — pass projectName to write to exactly one project');
        }
        const client = getProject(args.projectName);
        const result = await client.writeSection(
          args.filePath,
          args.sectionTitle,
          args.newContent,
          args.commitMessage
        );
        return {
          content: [
            {
              type: 'text',
              text: result || 'Section written and pushed successfully.',
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${maskToken(error.message)}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Overleaf MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});