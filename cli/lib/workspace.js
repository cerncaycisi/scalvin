'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScalvinError, invariant } = require('./errors');
const {
  PRIVATE_FILE_MODE,
  assertInside,
  validateRelativePath,
  ensurePrivateDir,
  atomicWriteFile,
  sha256Buffer,
  pathExists,
  rejectSymlinkPath,
  sha256File,
  walkTree,
  readBoundedRegularFile
} = require('./fs-safe');
const {
  validateSessionLifecyclePatch,
  createEmptySessionLifecyclePatch
} = require('../session-lifecycle');
const {
  SOURCE_ID_PATTERN,
  CONSENT_ID_PATTERN,
  SOURCE_STATUSES,
  normalizeSourceLocale
} = require('./source-provenance');

const STATE_SCHEMA_VERSION = 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLIENT_SETTINGS_BYTES = 1024 * 1024;
const MAX_CONSENT_PROJECTION_BYTES = 1024 * 1024;
const MAX_GITIGNORE_BYTES = 256 * 1024;

function slugify(value, fallback = 'companion') {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

function normalizeLanguagePreference(value) {
  const language = String(value);
  invariant(language.length > 0 && language.length <= 100 && !/[\0\s]/.test(language), 'Language must be auto or a valid BCP-47 language tag.', 'INVALID_PREFERENCE');
  if (language === 'auto') return language;
  invariant(/^[A-Za-z]{2,3}(?:-|$)/.test(language), 'Language must be auto or a valid BCP-47 language tag.', 'INVALID_PREFERENCE');
  let canonical;
  try {
    canonical = Intl.getCanonicalLocales(language);
  } catch {
    throw new ScalvinError('Language must be auto or a valid BCP-47 language tag.', 'INVALID_PREFERENCE');
  }
  invariant(canonical.length === 1, 'Language must be auto or a valid BCP-47 language tag.', 'INVALID_PREFERENCE');
  return canonical[0];
}

function createEmptySessionLifecycle() {
  return structuredClone(createEmptySessionLifecyclePatch().sessionLifecycle);
}

function createEmptySourceLifecycle() {
  return { schemaVersion: 1, records: [] };
}

const LEGACY_PERSONA_ALIASES = new Map([
  ['warm-4o', 'casual-warm']
]);

function normalizePreferences(manifest, options = {}, existing = undefined) {
  const defaults = manifest.defaults;
  const modalities = options.modality?.length
    ? options.modality.map((item) => slugify(item))
    : existing?.modalities || defaults.modalities;
  const requestedPersona = slugify(options.persona || existing?.persona || defaults.persona);
  const preferences = {
    companionName: String(options['companion-name'] || existing?.companionName || defaults.companionName),
    companionSlug: slugify(options['companion-name'] || existing?.companionName || defaults.companionName),
    language: normalizeLanguagePreference(options.language || existing?.language || defaults.language),
    persona: LEGACY_PERSONA_ALIASES.get(requestedPersona) || requestedPersona,
    structure: slugify(options.structure || existing?.structure || defaults.structure),
    modalities: [...new Set(modalities)]
  };
  invariant(preferences.companionName.length <= 100 && !/[\0\r\n]/.test(preferences.companionName), 'Companion name is invalid.', 'INVALID_PREFERENCE');

  const available = { persona: new Set(), structure: new Set(), modality: new Set() };
  for (const entry of manifest.files) {
    for (const target of entry.targets) {
      if (target.activation && available[target.activation.group]) {
        available[target.activation.group].add(target.activation.name);
      }
    }
  }
  invariant(available.persona.has(preferences.persona), 'Unknown persona.', 'UNKNOWN_SELECTION', { selection: preferences.persona, available: [...available.persona] });
  invariant(available.structure.has(preferences.structure), 'Unknown session structure.', 'UNKNOWN_SELECTION', { selection: preferences.structure, available: [...available.structure] });
  for (const modality of preferences.modalities) {
    invariant(available.modality.has(modality), 'Unknown modality.', 'UNKNOWN_SELECTION', { selection: modality, available: [...available.modality] });
  }
  return preferences;
}

function renderString(value, preferences) {
  const replacements = {
    '{{COMPANION_NAME}}': preferences.companionName,
    '{{COMPANION_SLUG}}': preferences.companionSlug,
    '{{DEFAULT_LANGUAGE}}': preferences.language,
    '{{DEFAULT_PERSONA}}': preferences.persona,
    '{{DEFAULT_STRUCTURE}}': preferences.structure,
    '{{DEFAULT_MODALITIES}}': preferences.modalities.join(', ')
  };
  let rendered = String(value);
  for (const [token, replacement] of Object.entries(replacements)) rendered = rendered.split(token).join(replacement);
  invariant(!/\{\{[A-Z0-9_]+\}\}/.test(rendered), 'Unresolved workspace placeholder.', 'UNRESOLVED_PLACEHOLDER', { value });
  return rendered;
}

function targetSelected(target, preferences) {
  if (!target.activation) return true;
  const { group, name } = target.activation;
  if (group === 'persona') return preferences.persona === name;
  if (group === 'structure') return preferences.structure === name;
  if (group === 'modality') return preferences.modalities.includes(name);
  return false;
}

function buildTargetPlan(manifest, sourceBuffers, preferences) {
  const plan = [];
  const targets = new Set();
  for (const entry of manifest.files) {
    const sourceData = sourceBuffers.get(entry.path);
    invariant(Buffer.isBuffer(sourceData), 'Verified source data is missing.', 'SOURCE_DATA_MISSING', { path: entry.path });
    for (const target of entry.targets) {
      if (!targetSelected(target, preferences)) continue;
      const targetPath = validateRelativePath(renderString(target.path, preferences));
      invariant(!targets.has(targetPath), 'Two selected sources map to the same target.', 'TARGET_COLLISION', { target: targetPath });
      targets.add(targetPath);
      const data = target.render === 'placeholders'
        ? Buffer.from(renderString(sourceData.toString('utf8'), preferences))
        : sourceData;
      plan.push({
        target: targetPath,
        sourcePath: entry.path,
        sourceHash: entry.sha256,
        installedHash: sha256Buffer(data),
        version: entry.version,
        role: entry.role,
        protection: target.protection,
        data
      });
    }
  }
  return plan.sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0);
}

async function writePlan(root, plan, options = {}) {
  const written = [];
  for (const item of plan) {
    const filename = path.resolve(root, item.target);
    assertInside(root, filename);
    await rejectSymlinkPath(filename, { allowMissing: true });
    if (options.preserveExisting && (item.protection === 'seed' || item.protection === 'protected') && await pathExists(filename)) continue;
    await ensurePrivateDir(path.dirname(filename));
    await atomicWriteFile(filename, item.data, { mode: PRIVATE_FILE_MODE });
    written.push(item.target);
  }
  return written;
}

async function ensureWorkspaceDirectories(root, manifest) {
  for (const relative of manifest.workspaceDirectories || []) {
    const normalized = validateRelativePath(relative);
    const absolute = path.resolve(root, normalized);
    assertInside(root, absolute);
    await rejectSymlinkPath(absolute, { allowMissing: true });
    await ensurePrivateDir(absolute);
  }
}

function integrationCommand(target) {
  return `node "${target}"`;
}

function containsCommand(value, command) {
  if (Array.isArray(value)) return value.some((item) => containsCommand(item, command));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCommand(item, command));
  return value === command;
}

async function readClientSettings(root, integration) {
  const relative = validateRelativePath(integration.settingsPath);
  const filename = path.resolve(root, relative);
  assertInside(root, filename);
  await rejectSymlinkPath(filename, { allowMissing: true });
  try {
    const raw = (await readBoundedRegularFile(filename, MAX_CLIENT_SETTINGS_BYTES, {
      typeCode: 'CLIENT_SETTINGS_INVALID', sizeCode: 'CLIENT_SETTINGS_TOO_LARGE', changedCode: 'CLIENT_SETTINGS_CHANGED'
    })).toString('utf8');
    const parsed = JSON.parse(raw);
    invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Client settings must be a JSON object.', 'CLIENT_SETTINGS_INVALID', { path: relative });
    return { filename, settings: parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { filename, settings: {} };
    if (error instanceof SyntaxError) throw new ScalvinError('Client settings are invalid JSON; refusing to overwrite them.', 'CLIENT_SETTINGS_INVALID', { path: relative, cause: error.message });
    throw error;
  }
}

async function clientIntegrationsNeedChange(root, manifest) {
  const integration = manifest.clientIntegrations?.claude;
  if (!integration?.hooks?.length) return false;
  const { settings } = await readClientSettings(root, integration);
  return integration.hooks.some((hook) => !containsCommand(settings, integrationCommand(hook.target)));
}

async function applyClientIntegrations(root, manifest) {
  const integration = manifest.clientIntegrations?.claude;
  if (!integration?.hooks?.length) return [];
  const { filename, settings } = await readClientSettings(root, integration);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : {};
  const existing = Array.isArray(settings.hooks[integration.event]) ? settings.hooks[integration.event] : [];
  const added = [];
  for (const hook of integration.hooks) {
    const command = integrationCommand(hook.target);
    if (containsCommand(existing, command)) continue;
    existing.push({
      matcher: '',
      hooks: [{ type: 'command', command, timeout: hook.timeoutSeconds || 2 }]
    });
    added.push(hook.target);
  }
  settings.hooks[integration.event] = existing;
  await atomicWriteFile(filename, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
}

function createState(manifest, preferences, plan, source, options = {}) {
  const now = options.now || new Date().toISOString();
  const consentStatus = options.consent || 'not-decided';
  const consentEventId = consentStatus === 'not-decided'
    ? null
    : options.consentEventId || `consent-${crypto.randomUUID()}`;
  const continuityOn = consentStatus === 'granted';
  const continuityRetention = continuityOn ? 'until_deleted' : 'do_not_store';
  const consent = {
    status: consentStatus,
    recordedAt: consentStatus === 'not-decided' ? null : now,
    eventId: consentEventId,
    eventAt: consentEventId ? now : null,
    eventCategory: consentEventId ? 'continuity_memory' : null,
    previousValue: consentEventId ? 'ask' : null,
    eventValue: consentEventId ? (continuityOn ? 'on' : 'off') : null,
    eventRetention: consentEventId ? continuityRetention : null,
    eventSource: consentEventId ? 'bootstrap' : null,
    noticeVersion: manifest.consentNoticeVersion,
    continuityMemory: continuityOn ? 'on' : consentStatus === 'declined' ? 'off' : 'ask',
    contextGraph: 'off',
    transcripts: 'off',
    importedSources: 'ask_each_import',
    externalCare: 'ask_each_import',
    behaviorLearning: 'ask',
    usageLedgers: 'on',
    preferredUserName: null,
    currentSessionId: null,
    memoryPause: { state: 'none', startedAt: null },
    transcriptState: {
      state: 'off',
      sessionId: null,
      captureGrade: null,
      startedAt: null,
      pausedIntervals: [],
      stoppedAt: null,
      knownGaps: []
    },
    timezone: { value: 'unconfirmed', status: 'unconfirmed', confirmedAt: null },
    accessibility: {
      responseLoad: 'standard',
      oneQuestionAtATime: 'unset',
      plainLanguageSummaries: 'unset',
      reducedMetaphor: 'unset',
      extraProcessingTime: 'unset',
      bodyPrompts: 'ask_first',
      sensoryGrounding: 'ask_first',
      betweenSessionExperiments: 'ask_first'
    },
    reviewPreferences: { staleMemoryOffers: 'on', suppressedMemoryIds: [] },
    lastOperationalEvent: null,
    decisions: {
      continuity_memory: consentEventId ? { at: now, eventId: consentEventId } : null,
      context_graph: null,
      raw_transcripts: null,
      imported_sources: null,
      external_care_records: null,
      behavior_customization: null,
      usage_ledgers: { at: now, eventId: 'bootstrap' }
    },
    retention: {
      profile_memory: continuityRetention,
      themes_and_focus: continuityRetention,
      session_notes: continuityRetention,
      primers_and_checkpoints: continuityRetention,
      reviews_and_summaries: continuityRetention,
      client_scene_memories: continuityRetention,
      context_graph: 'do_not_store',
      raw_transcripts: 'do_not_store',
      imported_sources: 'do_not_store',
      external_care_records: 'do_not_store',
      behavior_customization: 'do_not_store',
      usage_ledgers: 'until_deleted'
    }
  };
  const files = {};
  for (const item of plan) {
    files[item.target] = {
      sourcePath: item.sourcePath,
      sourceHash: item.sourceHash,
      installedHash: item.installedHash,
      version: item.version,
      role: item.role,
      protection: item.protection
    };
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    workspaceId: options.workspaceId || crypto.randomUUID(),
    createdAt: options.createdAt || now,
    updatedAt: now,
    product: {
      name: manifest.product.name,
      version: manifest.product.version,
      manifestSha256: source.manifestSha256
    },
    source: {
      locator: source.locator,
      pin: source.pin,
      pinType: source.pinType
    },
    consent,
    sessionLifecycle: createEmptySessionLifecycle(),
    sourceLifecycle: createEmptySourceLifecycle(),
    preferences,
    files
  };
}

const CONSENT_CATEGORY_FIELDS = {
  continuity_memory: 'continuityMemory',
  context_graph: 'contextGraph',
  raw_transcripts: 'transcripts',
  imported_sources: 'importedSources',
  external_care_records: 'externalCare',
  behavior_customization: 'behaviorLearning',
  usage_ledgers: 'usageLedgers'
};

const DATA_CLASS_CATEGORY = {
  profile_memory: 'continuity_memory',
  themes_and_focus: 'continuity_memory',
  session_notes: 'continuity_memory',
  primers_and_checkpoints: 'continuity_memory',
  reviews_and_summaries: 'continuity_memory',
  client_scene_memories: 'continuity_memory',
  context_graph: 'context_graph',
  raw_transcripts: 'raw_transcripts',
  imported_sources: 'imported_sources',
  external_care_records: 'external_care_records',
  behavior_customization: 'behavior_customization',
  usage_ledgers: 'usage_ledgers'
};

const CONSENT_CATEGORY_SPECS = {
  continuity_memory: { field: 'continuityMemory', values: ['ask', 'on', 'off'], dataClasses: ['profile_memory', 'themes_and_focus', 'session_notes', 'primers_and_checkpoints', 'reviews_and_summaries', 'client_scene_memories'] },
  context_graph: { field: 'contextGraph', values: ['off', 'on'], dataClasses: ['context_graph'] },
  raw_transcripts: { field: 'transcripts', values: ['off', 'on'], dataClasses: ['raw_transcripts'] },
  imported_sources: { field: 'importedSources', values: ['ask_each_import', 'off', 'on'], dataClasses: ['imported_sources'] },
  external_care_records: { field: 'externalCare', values: ['ask_each_import', 'off', 'on'], dataClasses: ['external_care_records'] },
  behavior_customization: { field: 'behaviorLearning', values: ['ask', 'off', 'on'], dataClasses: ['behavior_customization'] },
  usage_ledgers: { field: 'usageLedgers', values: ['off', 'on'], dataClasses: ['usage_ledgers'] }
};

function validateRetentionPolicy(value) {
  invariant(/^(?:until_deleted|do_not_store|session_only|rolling_days:\s*[1-9]\d*|until:\s*\d{4}-\d{2}-\d{2})$/.test(value || ''), 'Retention policy is invalid.', 'INVALID_RETENTION', { value });
  if (String(value).startsWith('until:')) {
    const date = String(value).slice('until:'.length).trim();
    const parsed = new Date(`${date}T00:00:00.000Z`);
    invariant(!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === date, 'Retention date is invalid.', 'INVALID_RETENTION', { value });
  }
  return value;
}

function validatePublicRetentionPolicy(value) {
  validateRetentionPolicy(value);
  invariant(['until_deleted', 'do_not_store'].includes(value), 'This retention policy is not supported by the current deterministic deletion engine.', 'UNSUPPORTED_RETENTION_POLICY', {
    value,
    supported: ['until_deleted', 'do_not_store']
  });
  return value;
}

function applyConsentChoice(state, choice = {}) {
  const spec = CONSENT_CATEGORY_SPECS[choice.category];
  invariant(spec, 'Unknown consent category.', 'INVALID_CONSENT_CATEGORY', { category: choice.category, available: Object.keys(CONSENT_CATEGORY_SPECS) });
  invariant(spec.values.includes(choice.value), 'Consent category value is invalid.', 'INVALID_CONSENT_VALUE', { category: choice.category, value: choice.value, available: spec.values });
  const now = choice.now || new Date().toISOString();
  const previousValue = state.consent[spec.field];
  const defaultRetention = choice.value === 'on' ? 'until_deleted' : choice.category === 'usage_ledgers' && choice.value === 'on' ? 'until_deleted' : 'do_not_store';
  const retention = validatePublicRetentionPolicy(choice.retention || defaultRetention);
  const previousPolicies = spec.dataClasses.map((dataClass) => state.consent.retention[dataClass]);
  const unchanged = previousValue === choice.value && previousPolicies.every((policy) => policy === retention);
  if (unchanged) return { changed: false, previousValue, value: choice.value, retention };

  const eventId = `consent-${crypto.randomUUID()}`;
  state.consent[spec.field] = choice.value;
  for (const dataClass of spec.dataClasses) state.consent.retention[dataClass] = retention;
  if (choice.category === 'raw_transcripts' && choice.value === 'off' && ['recording', 'paused'].includes(state.consent.transcriptState?.state)) {
    const transcript = state.consent.transcriptState;
    if (transcript.state === 'paused') {
      const interval = transcript.pausedIntervals.at(-1);
      if (interval?.endedAt === null) {
        interval.endedAt = now;
        transcript.knownGaps.push({ from: interval.startedAt, to: now, reason: 'consent_revoked_no_backfill' });
      }
    }
    transcript.state = 'stopped';
    transcript.stoppedAt = now;
  }
  if (choice.category === 'continuity_memory') {
    state.consent.status = choice.value === 'on' ? 'granted' : choice.value === 'off' ? 'declined' : 'not-decided';
    state.consent.recordedAt = choice.value === 'ask' ? null : now;
  }
  state.consent.eventId = eventId;
  state.consent.eventAt = now;
  state.consent.eventCategory = choice.category;
  state.consent.previousValue = previousValue;
  state.consent.eventValue = choice.value;
  state.consent.eventRetention = retention;
  state.consent.eventSource = choice.eventSource || 'cli-consent';
  state.consent.decisions[choice.category] = { at: now, eventId };
  state.updatedAt = now;
  return { changed: true, eventId, previousValue, value: choice.value, retention };
}

function categoryRetention(consent, category) {
  if (category === 'continuity_memory') return consent.retention.profile_memory;
  return consent.retention[category] || (category === 'usage_ledgers' ? 'until_deleted' : 'do_not_store');
}

function replaceMarkdownTableRow(markdown, key, cells) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`^\\|\\s*${escaped}\\s*\\|.*$`, 'm');
  invariant(expression.test(markdown), 'Consent template is missing a required table row.', 'CONSENT_TEMPLATE_INVALID', { key });
  return markdown.replace(expression, `| ${key} | ${cells.join(' | ')} |`);
}

function replaceSectionBullet(markdown, heading, label, value) {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  invariant(headingIndex !== -1, 'Consent template is missing a required section.', 'CONSENT_TEMPLATE_INVALID', { heading });
  const nextIndex = markdown.indexOf('\n## ', headingIndex + 3);
  const end = nextIndex === -1 ? markdown.length : nextIndex;
  const section = markdown.slice(headingIndex, end);
  const expression = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:.*$`, 'm');
  invariant(expression.test(section), 'Consent template is missing a required field.', 'CONSENT_TEMPLATE_INVALID', { heading, label });
  return `${markdown.slice(0, headingIndex)}${section.replace(expression, `- ${label}: ${value}`)}${markdown.slice(end)}`;
}

function readSectionBullet(markdown, heading, label) {
  const headingIndex = markdown.indexOf(`## ${heading}`);
  if (headingIndex === -1) return undefined;
  const nextIndex = markdown.indexOf('\n## ', headingIndex + 3);
  const section = markdown.slice(headingIndex, nextIndex === -1 ? markdown.length : nextIndex);
  const match = section.match(new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*)$`, 'm'));
  return match?.[1].trim();
}

function projectDataControlsMarkdown(markdown, state) {
  const consent = state.consent;
  invariant(consent && typeof consent === 'object', 'Canonical consent state is missing.', 'CONSENT_STATE_INVALID');
  const retentionHeading = '## Retention By Data Class';
  invariant(markdown.includes(retentionHeading), 'Consent template is missing the retention section.', 'CONSENT_TEMPLATE_INVALID');
  const [categorySection, ...retentionParts] = markdown.split(retentionHeading);
  let categories = categorySection;
  let retentionSection = retentionParts.join(retentionHeading);
  categories = categories.replace(/^- Timezone:.*$/m, `- Timezone: ${consent.timezone?.value || 'unconfirmed'}`);
  categories = categories.replace(/^- Timezone status:.*$/m, `- Timezone status: ${consent.timezone?.status || 'unconfirmed'}`);
  categories = categories.replace(/^- Timezone confirmed at:.*$/m, `- Timezone confirmed at: ${consent.timezone?.confirmedAt || 'null'}`);
  categories = categories.replace(/^- Preferred user name:.*$/m, `- Preferred user name: ${consent.preferredUserName || 'unset'}`);
  categories = categories.replace(/^- Current session ID:.*$/m, `- Current session ID: ${consent.currentSessionId || 'null'}`);
  categories = categories.replace(/^- Memory pause:.*$/m, `- Memory pause: ${consent.memoryPause?.state || 'none'}`);
  categories = categories.replace(/^- Pause started at:.*$/m, `- Pause started at: ${consent.memoryPause?.startedAt || 'null'}`);
  for (const [category, field] of Object.entries(CONSENT_CATEGORY_FIELDS)) {
    const retention = categoryRetention(consent, category);
    const decision = consent.decisions?.[category];
    const categoryDecided = decision?.at || 'null';
    const categoryEvent = decision?.eventId || 'null';
    categories = replaceMarkdownTableRow(categories, category, [consent[field], retention, categoryDecided, categoryEvent]);
  }
  for (const [dataClass, retention] of Object.entries(consent.retention)) {
    const decision = consent.decisions?.[DATA_CLASS_CATEGORY[dataClass]];
    const decided = decision?.at || 'null';
    const event = decision?.eventId || 'null';
    retentionSection = replaceMarkdownTableRow(retentionSection, dataClass, [retention, decided, event]);
  }
  let output = `${categories}${retentionHeading}${retentionSection}`;
  output = replaceSectionBullet(output, 'Transcript State', 'State', consent.transcriptState.state);
  output = replaceSectionBullet(output, 'Transcript State', 'Session ID', consent.transcriptState.sessionId || 'null');
  output = replaceSectionBullet(output, 'Transcript State', 'Capture grade', consent.transcriptState.captureGrade || 'null');
  output = replaceSectionBullet(output, 'Transcript State', 'Started at', consent.transcriptState.startedAt || 'null');
  output = replaceSectionBullet(output, 'Transcript State', 'Paused intervals', JSON.stringify(consent.transcriptState.pausedIntervals));
  output = replaceSectionBullet(output, 'Transcript State', 'Stopped at', consent.transcriptState.stoppedAt || 'null');
  output = replaceSectionBullet(output, 'Transcript State', 'Known gaps', JSON.stringify(consent.transcriptState.knownGaps));
  const lifecycle = state.sessionLifecycle;
  output = replaceSectionBullet(output, 'Session Lifecycle', 'State', lifecycle.state);
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Session ID', lifecycle.sessionId || 'null');
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Started at', lifecycle.startedAt || 'null');
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Started at UTC', lifecycle.startedAtUtc || 'null');
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Timezone', lifecycle.timezone === null ? 'null' : lifecycle.timezone);
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Resumed at', JSON.stringify(lifecycle.resumedAt || []));
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Closed at', lifecycle.closedAt || 'null');
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Completion', lifecycle.completion || 'null');
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Checkpoint', JSON.stringify(lifecycle.checkpoint));
  output = replaceSectionBullet(output, 'Session Lifecycle', 'Transcript evidence', JSON.stringify(lifecycle.transcript));
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Response load', consent.accessibility.responseLoad);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'One question at a time', consent.accessibility.oneQuestionAtATime);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Plain-language summaries', consent.accessibility.plainLanguageSummaries);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Reduced metaphor', consent.accessibility.reducedMetaphor);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Extra processing time', consent.accessibility.extraProcessingTime);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Body prompts', consent.accessibility.bodyPrompts);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Sensory grounding', consent.accessibility.sensoryGrounding);
  output = replaceSectionBullet(output, 'Accessibility Preferences', 'Between-session experiments', consent.accessibility.betweenSessionExperiments);
  output = replaceSectionBullet(output, 'Review Preferences', 'Stale-memory offers', consent.reviewPreferences.staleMemoryOffers);
  output = replaceSectionBullet(output, 'Review Preferences', 'Suppressed memory IDs', JSON.stringify(consent.reviewPreferences.suppressedMemoryIds));
  if (!output.includes('Canonical machine state: `.scalvin/state.json`')) {
    output = output.replace('# Data Controls\n', '# Data Controls\n\nCanonical machine state: `.scalvin/state.json`. This document is its human-readable projection.\n');
  }
  return output;
}

function projectConsentLedgerMarkdown(markdown, state) {
  const consent = state.consent;
  const header = '|---|---|---|---|---|---|---|---|---|';
  invariant(markdown.includes(header), 'Consent ledger template is missing its table header.', 'CONSENT_TEMPLATE_INVALID');
  let output = markdown;
  if (consent?.eventId && !output.includes(`| ${consent.eventId} |`)) {
    const category = consent.eventCategory || 'continuity_memory';
    const from = consent.previousValue || consent.previousContinuityMemory || 'ask';
    const to = consent.eventValue || consent.continuityMemory;
    const session = consent.eventSource || 'bootstrap';
    const retention = consent.eventRetention || categoryRetention(consent, category);
    const row = `| ${consent.eventId} | ${consent.eventAt || consent.recordedAt} | ${session} | ${category} | ${from} | ${to} | ${retention} | workspace | true |`;
    output = output.replace(header, `${header}\n${row}`);
  }
  const operational = consent?.lastOperationalEvent;
  if (operational?.eventId && !output.includes(`| ${operational.eventId} |`)) {
    const row = `| ${operational.eventId} | ${operational.at} | cli-control | ${operational.category} | ${operational.from} | ${operational.to} | unchanged | workspace | true |`;
    output = output.replace(header, `${header}\n${row}`);
  }
  return output;
}

async function projectConsentState(root, state) {
  const controlsPath = path.join(root, '.therapy', 'state', 'DATA-CONTROLS.md');
  const ledgerPath = path.join(root, '.therapy', 'state', 'CONSENT-LEDGER.md');
  await rejectSymlinkPath(controlsPath);
  await rejectSymlinkPath(ledgerPath);
  const controls = (await readBoundedRegularFile(controlsPath, MAX_CONSENT_PROJECTION_BYTES, {
    typeCode: 'CONSENT_PROJECTION_INVALID', sizeCode: 'CONSENT_PROJECTION_TOO_LARGE', changedCode: 'CONSENT_PROJECTION_CHANGED'
  })).toString('utf8');
  const ledger = (await readBoundedRegularFile(ledgerPath, MAX_CONSENT_PROJECTION_BYTES, {
    typeCode: 'CONSENT_LEDGER_INVALID', sizeCode: 'CONSENT_LEDGER_TOO_LARGE', changedCode: 'CONSENT_LEDGER_CHANGED'
  })).toString('utf8');
  await atomicWriteFile(controlsPath, projectDataControlsMarkdown(controls, state));
  await atomicWriteFile(ledgerPath, projectConsentLedgerMarkdown(ledger, state));
}

async function consentProjectionNeedsChange(root, state) {
  try {
    const controls = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'DATA-CONTROLS.md'), MAX_CONSENT_PROJECTION_BYTES, {
      typeCode: 'CONSENT_PROJECTION_INVALID', sizeCode: 'CONSENT_PROJECTION_TOO_LARGE', changedCode: 'CONSENT_PROJECTION_CHANGED'
    })).toString('utf8');
    if (consentProjectionDifferences(controls, state).length) return true;
    if (state.consent?.eventId) {
      const ledger = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
        typeCode: 'CONSENT_LEDGER_INVALID', sizeCode: 'CONSENT_LEDGER_TOO_LARGE', changedCode: 'CONSENT_LEDGER_CHANGED'
      })).toString('utf8');
      if (!ledger.includes(`| ${state.consent.eventId} |`)) return true;
    }
    if (state.consent?.lastOperationalEvent?.eventId) {
      const ledger = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
        typeCode: 'CONSENT_LEDGER_INVALID', sizeCode: 'CONSENT_LEDGER_TOO_LARGE', changedCode: 'CONSENT_LEDGER_CHANGED'
      })).toString('utf8');
      if (!ledger.includes(`| ${state.consent.lastOperationalEvent.eventId} |`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function parseDataControlsMarkdown(markdown) {
  const retentionHeading = '## Retention By Data Class';
  const [categorySection, ...retentionParts] = markdown.split(retentionHeading);
  const retentionSection = retentionParts.join(retentionHeading);
  const values = {};
  for (const [category, field] of Object.entries(CONSENT_CATEGORY_FIELDS)) {
    const escaped = category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = categorySection.match(new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm'));
    if (match) values[field] = match[1].trim();
  }
  const retention = {};
  for (const dataClass of ['profile_memory', 'themes_and_focus', 'session_notes', 'primers_and_checkpoints', 'reviews_and_summaries', 'client_scene_memories', 'context_graph', 'raw_transcripts', 'imported_sources', 'external_care_records', 'behavior_customization', 'usage_ledgers']) {
    const match = retentionSection.match(new RegExp(`^\\|\\s*${dataClass}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'm'));
    if (match) retention[dataClass] = match[1].trim();
  }
  const bullet = (label) => markdown.match(new RegExp(`^- ${label}:\\s*(.*)$`, 'm'))?.[1].trim();
  const parseJsonArray = (value) => {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
  };
  return {
    ...values,
    retention,
    operational: {
      preferredUserName: bullet('Preferred user name') === 'unset' ? null : bullet('Preferred user name'),
      currentSessionId: bullet('Current session ID') === 'null' ? null : bullet('Current session ID'),
      memoryPause: { state: bullet('Memory pause'), startedAt: bullet('Pause started at') === 'null' ? null : bullet('Pause started at') },
      timezone: {
        value: bullet('Timezone'),
        status: bullet('Timezone status'),
        confirmedAt: bullet('Timezone confirmed at') === 'null' ? null : bullet('Timezone confirmed at')
      },
      transcriptState: {
        state: readSectionBullet(markdown, 'Transcript State', 'State'),
        sessionId: readSectionBullet(markdown, 'Transcript State', 'Session ID') === 'null' ? null : readSectionBullet(markdown, 'Transcript State', 'Session ID'),
        captureGrade: readSectionBullet(markdown, 'Transcript State', 'Capture grade') === 'null' ? null : readSectionBullet(markdown, 'Transcript State', 'Capture grade'),
        startedAt: readSectionBullet(markdown, 'Transcript State', 'Started at') === 'null' ? null : readSectionBullet(markdown, 'Transcript State', 'Started at'),
        pausedIntervals: parseJsonArray(readSectionBullet(markdown, 'Transcript State', 'Paused intervals')),
        stoppedAt: readSectionBullet(markdown, 'Transcript State', 'Stopped at') === 'null' ? null : readSectionBullet(markdown, 'Transcript State', 'Stopped at'),
        knownGaps: parseJsonArray(readSectionBullet(markdown, 'Transcript State', 'Known gaps'))
      },
      sessionLifecycle: {
        state: readSectionBullet(markdown, 'Session Lifecycle', 'State'),
        sessionId: readSectionBullet(markdown, 'Session Lifecycle', 'Session ID') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Session ID'),
        startedAt: readSectionBullet(markdown, 'Session Lifecycle', 'Started at') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Started at'),
        startedAtUtc: readSectionBullet(markdown, 'Session Lifecycle', 'Started at UTC') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Started at UTC'),
        timezone: readSectionBullet(markdown, 'Session Lifecycle', 'Timezone') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Timezone'),
        resumedAt: parseJsonArray(readSectionBullet(markdown, 'Session Lifecycle', 'Resumed at')),
        closedAt: readSectionBullet(markdown, 'Session Lifecycle', 'Closed at') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Closed at'),
        completion: readSectionBullet(markdown, 'Session Lifecycle', 'Completion') === 'null' ? null : readSectionBullet(markdown, 'Session Lifecycle', 'Completion'),
        checkpoint: (() => { try { return JSON.parse(readSectionBullet(markdown, 'Session Lifecycle', 'Checkpoint')); } catch { return undefined; } })(),
        transcript: (() => { try { return JSON.parse(readSectionBullet(markdown, 'Session Lifecycle', 'Transcript evidence')); } catch { return undefined; } })()
      },
      accessibility: {
        responseLoad: readSectionBullet(markdown, 'Accessibility Preferences', 'Response load'),
        oneQuestionAtATime: readSectionBullet(markdown, 'Accessibility Preferences', 'One question at a time'),
        plainLanguageSummaries: readSectionBullet(markdown, 'Accessibility Preferences', 'Plain-language summaries'),
        reducedMetaphor: readSectionBullet(markdown, 'Accessibility Preferences', 'Reduced metaphor'),
        extraProcessingTime: readSectionBullet(markdown, 'Accessibility Preferences', 'Extra processing time'),
        bodyPrompts: readSectionBullet(markdown, 'Accessibility Preferences', 'Body prompts'),
        sensoryGrounding: readSectionBullet(markdown, 'Accessibility Preferences', 'Sensory grounding'),
        betweenSessionExperiments: readSectionBullet(markdown, 'Accessibility Preferences', 'Between-session experiments')
      },
      reviewPreferences: {
        staleMemoryOffers: readSectionBullet(markdown, 'Review Preferences', 'Stale-memory offers'),
        suppressedMemoryIds: parseJsonArray(readSectionBullet(markdown, 'Review Preferences', 'Suppressed memory IDs'))
      }
    }
  };
}

function consentProjectionDifferences(markdown, state) {
  const parsed = parseDataControlsMarkdown(markdown);
  const differences = [];
  for (const field of Object.values(CONSENT_CATEGORY_FIELDS)) {
    if (parsed[field] !== state.consent?.[field]) differences.push({ field, canonical: state.consent?.[field], projected: parsed[field] });
  }
  for (const [dataClass, canonical] of Object.entries(state.consent?.retention || {})) {
    if (parsed.retention[dataClass] !== canonical) differences.push({ field: `retention.${dataClass}`, canonical, projected: parsed.retention[dataClass] });
  }
  const compareObject = (prefix, canonical, projected) => {
    for (const [key, value] of Object.entries(canonical || {})) {
      const actual = projected?.[key];
      if (JSON.stringify(actual) !== JSON.stringify(value)) differences.push({ field: `${prefix}.${key}`, canonical: value, projected: actual });
    }
  };
  for (const key of ['preferredUserName', 'currentSessionId']) {
    if (parsed.operational[key] !== state.consent?.[key]) differences.push({ field: key, canonical: state.consent?.[key], projected: parsed.operational[key] });
  }
  compareObject('memoryPause', state.consent?.memoryPause, parsed.operational.memoryPause);
  compareObject('timezone', state.consent?.timezone, parsed.operational.timezone);
  compareObject('transcriptState', state.consent?.transcriptState, parsed.operational.transcriptState);
  compareObject('sessionLifecycle', state.sessionLifecycle, parsed.operational.sessionLifecycle);
  compareObject('accessibility', state.consent?.accessibility, parsed.operational.accessibility);
  compareObject('reviewPreferences', state.consent?.reviewPreferences, parsed.operational.reviewPreferences);
  return differences;
}

function compatibilityState(state) {
  return {
    schemaVersion: 2,
    workspaceId: state.workspaceId,
    installedVersion: state.product.version,
    stateFile: '.scalvin/state.json',
    updatedAt: state.updatedAt
  };
}

async function writeState(workspace, state, manifest) {
  validateWorkspaceState(state);
  const statePath = manifest.state?.path || '.scalvin/state.json';
  const absoluteState = path.resolve(workspace, validateRelativePath(statePath));
  assertInside(workspace, absoluteState);
  await atomicWriteFile(absoluteState, `${JSON.stringify(state, null, 2)}\n`);
  const compatibilityPath = path.resolve(workspace, '.therapy/version.json');
  assertInside(workspace, compatibilityPath);
  await atomicWriteFile(compatibilityPath, `${JSON.stringify(compatibilityState(state), null, 2)}\n`);
}

const SOURCE_RECORD_KEYS = Object.freeze([
  'sourceId', 'revision', 'kind', 'locale', 'sha256', 'byteLength', 'status', 'trust',
  'importedAt', 'consentEventId', 'retention', 'contentObject', 'recordObject',
  'lastIntegratedHash', 'lastIntegratedAt', 'derivedMemoryIds', 'error'
]);

function exactObjectKeys(value, expected, code, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} has unknown or missing fields.`, code);
}

function strictSourceTimestamp(value) {
  const match = typeof value === 'string' && value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/);
  invariant(match && Number(match[6]) <= 59 && Number(match[9] || 0) <= 23 && Number(match[10] || 0) <= 59, 'Source lifecycle timestamp is invalid.', 'SOURCE_PATCH_INVALID');
  const epoch = Date.parse(value);
  invariant(!Number.isNaN(epoch), 'Source lifecycle timestamp is invalid.', 'SOURCE_PATCH_INVALID');
  const offset = match[7] === 'Z' ? 0 : (match[8] === '+' ? 1 : -1) * (Number(match[9]) * 60 + Number(match[10]));
  const local = new Date(epoch + offset * 60_000);
  invariant(local.getUTCFullYear() === Number(match[1]) && local.getUTCMonth() + 1 === Number(match[2]) && local.getUTCDate() === Number(match[3]) && local.getUTCHours() === Number(match[4]) && local.getUTCMinutes() === Number(match[5]) && local.getUTCSeconds() === Number(match[6]), 'Source lifecycle timestamp is invalid.', 'SOURCE_PATCH_INVALID');
  return value;
}

function validateSourceLifecycleRecord(record) {
  exactObjectKeys(record, SOURCE_RECORD_KEYS, 'SOURCE_PATCH_INVALID', 'Source lifecycle record');
  invariant(SOURCE_ID_PATTERN.test(record.sourceId || '') && record.sourceId === record.sourceId.toLowerCase(), 'Source lifecycle ID is invalid.', 'SOURCE_PATCH_INVALID');
  invariant(Number.isSafeInteger(record.revision) && record.revision > 0, 'Source lifecycle revision is invalid.', 'SOURCE_PATCH_INVALID');
  invariant(['imported_source', 'external_care_note'].includes(record.kind), 'Source lifecycle kind is invalid.', 'SOURCE_PATCH_INVALID');
  invariant(record.locale === null || normalizeSourceLocale(record.locale) === record.locale, 'Source lifecycle locale is invalid.', 'SOURCE_PATCH_INVALID');
  invariant(SHA256_PATTERN.test(record.sha256 || '') && Number.isSafeInteger(record.byteLength) && record.byteLength >= 0 && record.byteLength <= 8 * 1024 * 1024, 'Source lifecycle integrity metadata is invalid.', 'SOURCE_PATCH_INVALID');
  invariant(SOURCE_STATUSES.has(record.status) && record.trust === 'untrusted_data', 'Source lifecycle status or trust is invalid.', 'SOURCE_PATCH_INVALID');
  strictSourceTimestamp(record.importedAt);
  invariant(CONSENT_ID_PATTERN.test(record.consentEventId || ''), 'Source lifecycle consent event is invalid.', 'SOURCE_PATCH_INVALID');
  validateRetentionPolicy(record.retention);
  invariant(record.retention !== 'do_not_store', 'Source lifecycle cannot persist a do-not-store record.', 'SOURCE_PATCH_INVALID');
  const padded = String(record.revision).padStart(4, '0');
  const expectedContent = `sources/objects/${record.sourceId}/r${padded}--${record.sha256}.source`;
  const expectedRecord = `sources/records/${record.sourceId}--r${padded}.md`;
  const removed = ['deleted', 'rejected'].includes(record.status);
  invariant(removed
    ? record.contentObject === null && record.recordObject === null
    : record.contentObject === expectedContent && record.recordObject === expectedRecord,
  'Source lifecycle object paths are invalid.', 'SOURCE_PATCH_INVALID');
  invariant((record.lastIntegratedHash === null) === (record.lastIntegratedAt === null), 'Source integration metadata is incomplete.', 'SOURCE_PATCH_INVALID');
  if (record.lastIntegratedHash !== null) {
    invariant(record.lastIntegratedHash === record.sha256, 'Source integration hash is invalid.', 'SOURCE_PATCH_INVALID');
    strictSourceTimestamp(record.lastIntegratedAt);
  }
  invariant(Array.isArray(record.derivedMemoryIds) && record.derivedMemoryIds.length <= 100, 'Source-derived memory IDs are invalid.', 'SOURCE_PATCH_INVALID');
  const ids = record.derivedMemoryIds.map((item) => String(item).toLowerCase());
  invariant(new Set(ids).size === ids.length && ids.every((item, index) => item === record.derivedMemoryIds[index] && /^(?:mem|theme|focus)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item)), 'Source-derived memory IDs are invalid.', 'SOURCE_PATCH_INVALID');
  if (record.error !== null) {
    exactObjectKeys(record.error, ['code', 'message'], 'SOURCE_PATCH_INVALID', 'Source lifecycle error');
    invariant(/^[A-Z][A-Z0-9_]{2,80}$/.test(record.error.code || '') && typeof record.error.message === 'string' && record.error.message.length <= 300 && !/[\0\r\n|]/.test(record.error.message), 'Source lifecycle error is invalid.', 'SOURCE_PATCH_INVALID');
  }
  invariant((record.status === 'failed') === (record.error !== null), 'Source lifecycle failure metadata is inconsistent.', 'SOURCE_PATCH_INVALID');
  return record;
}

function validateSourceLifecycleState(sourceLifecycle) {
  exactObjectKeys(sourceLifecycle, ['schemaVersion', 'records'], 'WORKSPACE_STATE_INVALID', 'Source lifecycle state');
  invariant(sourceLifecycle.schemaVersion === 1 && Array.isArray(sourceLifecycle.records) && sourceLifecycle.records.length <= 10_000, 'Source lifecycle state is invalid.', 'WORKSPACE_STATE_INVALID');
  let previous = null;
  const seen = new Set();
  for (const record of sourceLifecycle.records) {
    try { validateSourceLifecycleRecord(record); }
    catch (error) { throw new ScalvinError('Workspace source lifecycle record is invalid.', 'WORKSPACE_STATE_INVALID', { causeCode: error.code || 'SOURCE_PATCH_INVALID' }); }
    const key = `${record.sourceId}@${record.revision}`;
    invariant(!seen.has(key) && (previous === null || previous < key), 'Source lifecycle records are duplicated or not canonically sorted.', 'WORKSPACE_STATE_INVALID');
    seen.add(key);
    previous = key;
  }
  return sourceLifecycle;
}

function validateSourceLifecyclePatch(canonicalPatch) {
  exactObjectKeys(canonicalPatch, ['sourceLifecycle'], 'SOURCE_PATCH_INVALID', 'Canonical source patch');
  const lifecycle = canonicalPatch.sourceLifecycle;
  invariant(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle), 'Canonical source patch is invalid.', 'SOURCE_PATCH_INVALID');
  const validateOne = (entry) => {
    exactObjectKeys(entry, ['operation', 'sourceId', 'revision', 'record'], 'SOURCE_PATCH_INVALID', 'Source patch entry');
    invariant(['upsert', 'delete'].includes(entry.operation), 'Source patch operation is invalid.', 'SOURCE_PATCH_INVALID');
    validateSourceLifecycleRecord(entry.record);
    invariant(entry.sourceId === entry.record.sourceId && entry.revision === entry.record.revision, 'Source patch identity is inconsistent.', 'SOURCE_PATCH_INVALID');
    invariant(entry.operation !== 'delete' || entry.record.status === 'deleted', 'Source delete patch has an invalid status.', 'SOURCE_PATCH_INVALID');
    return entry;
  };
  if (['upsert', 'delete'].includes(lifecycle.operation)) {
    validateOne(lifecycle);
    return canonicalPatch;
  }
  exactObjectKeys(lifecycle, ['operation', 'records'], 'SOURCE_PATCH_INVALID', 'Source multi-record patch');
  invariant(['upsert_many', 'delete_many'].includes(lifecycle.operation) && Array.isArray(lifecycle.records) && lifecycle.records.length > 0 && lifecycle.records.length <= 10_000, 'Source multi-record patch is invalid.', 'SOURCE_PATCH_INVALID');
  for (const entry of lifecycle.records) {
    validateOne(entry);
    invariant(entry.operation === (lifecycle.operation === 'delete_many' ? 'delete' : 'upsert'), 'Source multi-record patch operation is inconsistent.', 'SOURCE_PATCH_INVALID');
  }
  return canonicalPatch;
}

function applySourceLifecyclePatch(state, canonicalPatch) {
  validateSourceLifecyclePatch(canonicalPatch);
  validateSourceLifecycleState(state.sourceLifecycle);
  const lifecycle = canonicalPatch.sourceLifecycle;
  const entries = ['upsert', 'delete'].includes(lifecycle.operation) ? [lifecycle] : lifecycle.records;
  const records = state.sourceLifecycle.records.map((record) => structuredClone(record));
  for (const entry of entries) {
    const existingIndex = records.findIndex((record) => record.sourceId === entry.sourceId && record.revision === entry.revision);
    if (entry.operation === 'delete') {
      if (existingIndex !== -1) records.splice(existingIndex, 1);
      continue;
    }
    if (!['failed', 'rejected', 'deleted'].includes(entry.record.status)) {
      for (let index = 0; index < records.length; index += 1) {
        const prior = records[index];
        if (prior.sourceId === entry.sourceId && prior.revision < entry.revision && !['deleted', 'rejected', 'superseded', 'failed'].includes(prior.status)) {
          records[index] = { ...prior, status: 'superseded' };
        }
      }
    }
    if (existingIndex === -1) records.push(structuredClone(entry.record));
    else records[existingIndex] = structuredClone(entry.record);
  }
  records.sort((a, b) => {
    const first = `${a.sourceId}@${a.revision}`;
    const second = `${b.sourceId}@${b.revision}`;
    return first < second ? -1 : first > second ? 1 : 0;
  });
  state.sourceLifecycle = { schemaVersion: 1, records };
  validateSourceLifecycleState(state.sourceLifecycle);
  return state.sourceLifecycle;
}

function validateWorkspaceState(state) {
  invariant(state && typeof state === 'object' && !Array.isArray(state), 'Workspace state must be an object.', 'WORKSPACE_STATE_INVALID');
  invariant(state.schemaVersion === STATE_SCHEMA_VERSION, 'Workspace state schema is not v2.', 'WORKSPACE_STATE_INVALID');
  invariant(UUID_PATTERN.test(state.workspaceId || ''), 'Workspace ID is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(typeof state.createdAt === 'string' && !Number.isNaN(Date.parse(state.createdAt)), 'Workspace createdAt is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(typeof state.updatedAt === 'string' && !Number.isNaN(Date.parse(state.updatedAt)), 'Workspace updatedAt is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(state.product?.name === 'scalvin' && typeof state.product.version === 'string', 'Workspace product identity is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(SHA256_PATTERN.test(state.product.manifestSha256 || ''), 'Workspace manifest hash is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(typeof state.source?.locator === 'string' && typeof state.source?.pin === 'string' && ['release', 'commit', 'manifest-sha256'].includes(state.source?.pinType), 'Workspace source pin is invalid.', 'WORKSPACE_STATE_INVALID');
  if (state.source.pinType === 'manifest-sha256') invariant(SHA256_PATTERN.test(state.source.pin), 'Workspace manifest source pin is invalid.', 'WORKSPACE_STATE_INVALID');
  if (state.source.pinType === 'commit') invariant(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(state.source.pin), 'Workspace commit source pin is invalid.', 'WORKSPACE_STATE_INVALID');
  if (state.source.pinType === 'release') invariant(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(state.source.pin), 'Workspace release source pin is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(state.consent && ['not-decided', 'granted', 'declined'].includes(state.consent.status), 'Workspace consent state is invalid.', 'WORKSPACE_STATE_INVALID');
  const consent = state.consent;
  const expectedContinuity = consent.status === 'granted' ? 'on' : consent.status === 'declined' ? 'off' : 'ask';
  invariant(consent.continuityMemory === expectedContinuity, 'Continuity consent does not match global status.', 'WORKSPACE_STATE_INVALID');
  invariant(['off', 'on'].includes(consent.contextGraph), 'Context graph consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(['off', 'on'].includes(consent.transcripts), 'Transcript consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(['ask_each_import', 'off', 'on'].includes(consent.importedSources), 'Imported-source consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(['ask_each_import', 'off', 'on'].includes(consent.externalCare), 'External-care consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(['ask', 'off', 'on'].includes(consent.behaviorLearning), 'Behavior-customization consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(['off', 'on'].includes(consent.usageLedgers), 'Usage-ledger consent is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(typeof consent.retention === 'object' && consent.retention, 'Workspace retention state is missing.', 'WORKSPACE_STATE_INVALID');
  for (const dataClass of Object.keys(DATA_CLASS_CATEGORY)) {
    try {
      validateRetentionPolicy(consent.retention[dataClass]);
    } catch (error) {
      throw new ScalvinError('Workspace retention policy is missing or invalid.', 'WORKSPACE_STATE_INVALID', { dataClass, policy: consent.retention[dataClass], cause: error.message });
    }
  }
  invariant(consent.timezone && typeof consent.timezone.value === 'string' && ['unconfirmed', 'confirmed'].includes(consent.timezone.status), 'Workspace timezone state is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.timezone.confirmedAt === null || (typeof consent.timezone.confirmedAt === 'string' && !Number.isNaN(Date.parse(consent.timezone.confirmedAt))), 'Workspace timezone confirmation time is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.preferredUserName === null || typeof consent.preferredUserName === 'string', 'Preferred-user-name state is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.currentSessionId === null || /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(consent.currentSessionId), 'Current session ID is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.memoryPause && ['none', 'write_pause', 'sealed_pause'].includes(consent.memoryPause.state), 'Memory-pause state is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.memoryPause.startedAt === null || (typeof consent.memoryPause.startedAt === 'string' && !Number.isNaN(Date.parse(consent.memoryPause.startedAt))), 'Memory-pause timestamp is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.transcriptState && ['off', 'recording', 'paused', 'stopped'].includes(consent.transcriptState.state), 'Transcript lifecycle state is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.transcriptState.sessionId === null || /^s-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(consent.transcriptState.sessionId), 'Transcript session ID is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.transcriptState.captureGrade === null || ['client_captured', 'turn_captured', 'best_effort_context', 'partial'].includes(consent.transcriptState.captureGrade), 'Transcript capture grade is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(Array.isArray(consent.transcriptState.pausedIntervals) && Array.isArray(consent.transcriptState.knownGaps), 'Transcript interval/gap state is invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(consent.accessibility && ['concise', 'standard', 'detailed'].includes(consent.accessibility.responseLoad), 'Response-load accessibility state is invalid.', 'WORKSPACE_STATE_INVALID');
  for (const key of ['oneQuestionAtATime', 'plainLanguageSummaries', 'reducedMetaphor', 'extraProcessingTime']) {
    invariant(['unset', 'on', 'off'].includes(consent.accessibility[key]), 'Accessibility preference state is invalid.', 'WORKSPACE_STATE_INVALID', { key });
  }
  for (const key of ['bodyPrompts', 'sensoryGrounding', 'betweenSessionExperiments']) {
    invariant(['allowed', 'ask_first', 'off'].includes(consent.accessibility[key]), 'Accessibility/body preference is invalid.', 'WORKSPACE_STATE_INVALID', { key });
  }
  invariant(consent.reviewPreferences && ['on', 'off'].includes(consent.reviewPreferences.staleMemoryOffers) && Array.isArray(consent.reviewPreferences.suppressedMemoryIds), 'Review preferences are invalid.', 'WORKSPACE_STATE_INVALID');
  try {
    validateSessionLifecyclePatch({
      consent: { currentSessionId: consent.currentSessionId },
      sessionLifecycle: state.sessionLifecycle
    });
  } catch (error) {
    throw new ScalvinError('Workspace session lifecycle state is invalid.', 'WORKSPACE_STATE_INVALID', { causeCode: error.code || 'SESSION_PATCH_INVALID' });
  }
  validateSourceLifecycleState(state.sourceLifecycle);
  invariant(consent.decisions && typeof consent.decisions === 'object', 'Consent decision metadata is missing.', 'WORKSPACE_STATE_INVALID');
  for (const category of Object.keys(CONSENT_CATEGORY_FIELDS)) {
    const decision = consent.decisions[category];
    invariant(decision === null || (typeof decision?.at === 'string' && typeof decision?.eventId === 'string'), 'Consent decision metadata is invalid.', 'WORKSPACE_STATE_INVALID', { category });
  }
  if (consent.eventId !== null) invariant(/^consent-[0-9a-f-]{36}$/i.test(consent.eventId || ''), 'Consent event ID is invalid.', 'WORKSPACE_STATE_INVALID');
  if (consent.eventId !== null) {
    invariant(typeof consent.eventAt === 'string' && !Number.isNaN(Date.parse(consent.eventAt)), 'Consent event timestamp is invalid.', 'WORKSPACE_STATE_INVALID');
    invariant(CONSENT_CATEGORY_SPECS[consent.eventCategory]?.values.includes(consent.eventValue), 'Consent event category/value is invalid.', 'WORKSPACE_STATE_INVALID');
    validateRetentionPolicy(consent.eventRetention);
  }
  if (consent.lastOperationalEvent !== null) {
    const event = consent.lastOperationalEvent;
    invariant(/^control-[0-9a-f-]{36}$/i.test(event?.eventId || '') && typeof event.at === 'string' && !Number.isNaN(Date.parse(event.at)), 'Operational control event is invalid.', 'WORKSPACE_STATE_INVALID');
    invariant(['memory_pause', 'memory_correction', 'memory_deletion', 'transcript_state', 'transcript_deletion', 'timezone', 'language_preference', 'accessibility', 'identity_preference', 'context_graph'].includes(event.category) && typeof event.from === 'string' && typeof event.to === 'string', 'Operational control event fields are invalid.', 'WORKSPACE_STATE_INVALID');
  }
  invariant(state.preferences && typeof state.preferences === 'object' && Array.isArray(state.preferences.modalities), 'Workspace preferences are invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(typeof state.preferences.companionName === 'string' && typeof state.preferences.language === 'string', 'Workspace display preferences are invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(normalizeLanguagePreference(state.preferences.language) === state.preferences.language, 'Workspace language preference is not canonical.', 'WORKSPACE_STATE_INVALID');
  invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.preferences.companionSlug || '') && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.preferences.persona || '') && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.preferences.structure || ''), 'Workspace selector preferences are invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(state.preferences.modalities.length > 0 && state.preferences.modalities.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item)), 'Workspace modality preferences are invalid.', 'WORKSPACE_STATE_INVALID');
  invariant(state.files && typeof state.files === 'object' && !Array.isArray(state.files), 'Workspace managed-file state is invalid.', 'WORKSPACE_STATE_INVALID');
  for (const [target, record] of Object.entries(state.files)) {
    const normalized = validateRelativePath(target);
    invariant(normalized === target, 'Workspace state paths must use normalized forward slashes.', 'WORKSPACE_STATE_INVALID', { target });
    invariant(record && typeof record === 'object', 'Managed-file record is invalid.', 'WORKSPACE_STATE_INVALID', { target });
    validateRelativePath(record.sourcePath);
    invariant(SHA256_PATTERN.test(record.sourceHash || '') && SHA256_PATTERN.test(record.installedHash || ''), 'Managed-file hashes are invalid.', 'WORKSPACE_STATE_INVALID', { target });
    invariant(typeof record.version === 'string' && typeof record.role === 'string', 'Managed-file metadata is invalid.', 'WORKSPACE_STATE_INVALID', { target });
    invariant(['framework', 'active', 'seed', 'protected'].includes(record.protection), 'Managed-file protection is invalid.', 'WORKSPACE_STATE_INVALID', { target });
  }
  return state;
}

async function validateWorkspaceStage(root, options = {}) {
  await rejectSymlinkPath(root);
  await walkTree(root); // rejects every symlink and unsupported file type
  const manifest = options.manifest || { state: { path: '.scalvin/state.json' } };
  const stateResult = await loadWorkspaceState(root, manifest);
  invariant(stateResult.kind === 'current', 'Staged workspace has no valid canonical state.', 'STAGE_VALIDATION_FAILED', { kind: stateResult.kind, error: stateResult.error });
  const state = stateResult.state;
  if (options.manifestSha256) {
    invariant(state.product.manifestSha256 === options.manifestSha256, 'Staged workspace manifest identity mismatch.', 'STAGE_VALIDATION_FAILED');
  }
  const sourceEntries = options.manifest ? new Map(options.manifest.files.map((entry) => [entry.path, entry])) : null;
  for (const [target, record] of Object.entries(state.files)) {
    const filename = path.resolve(root, validateRelativePath(target));
    assertInside(root, filename, 'Staged managed file');
    invariant(await pathExists(filename), 'Staged managed file is missing.', 'STAGE_VALIDATION_FAILED', { target });
    const actual = await sha256File(filename);
    if (!['seed', 'protected'].includes(record.protection)) {
      invariant(actual === record.installedHash, 'Staged managed framework file hash mismatch.', 'STAGE_VALIDATION_FAILED', { target, expected: record.installedHash, actual });
    }
    if (sourceEntries) {
      const source = sourceEntries.get(record.sourcePath);
      invariant(source && source.sha256 === record.sourceHash && source.version === record.version, 'Staged source registry mismatch.', 'STAGE_VALIDATION_FAILED', { target, sourcePath: record.sourcePath });
    }
  }
  if (options.expectedPlan) {
    const expectedTargets = new Set(options.expectedPlan.map((item) => item.target));
    invariant(Object.keys(state.files).length === expectedTargets.size, 'Staged canonical state contains an unexpected managed target count.', 'STAGE_VALIDATION_FAILED', { expected: expectedTargets.size, actual: Object.keys(state.files).length });
    for (const item of options.expectedPlan) {
      const record = state.files[item.target];
      invariant(record && record.installedHash === item.installedHash && record.sourcePath === item.sourcePath && record.sourceHash === item.sourceHash && record.version === item.version && record.role === item.role && record.protection === item.protection, 'Staged manifest target is absent or inconsistent in canonical state.', 'STAGE_VALIDATION_FAILED', { target: item.target });
    }
    for (const target of Object.keys(state.files)) invariant(expectedTargets.has(target), 'Staged canonical state contains an unexpected managed target.', 'STAGE_VALIDATION_FAILED', { target });
  }
  const controls = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'DATA-CONTROLS.md'), MAX_CONSENT_PROJECTION_BYTES, {
    typeCode: 'STAGE_VALIDATION_FAILED', sizeCode: 'STAGE_VALIDATION_FAILED', changedCode: 'STAGE_VALIDATION_FAILED'
  })).toString('utf8');
  invariant(consentProjectionDifferences(controls, state).length === 0, 'Staged consent projection differs from canonical state.', 'STAGE_VALIDATION_FAILED');
  if (state.consent?.eventId) {
    const ledger = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
      typeCode: 'STAGE_VALIDATION_FAILED', sizeCode: 'STAGE_VALIDATION_FAILED', changedCode: 'STAGE_VALIDATION_FAILED'
    })).toString('utf8');
    invariant(ledger.includes(`| ${state.consent.eventId} |`), 'Staged consent event is missing from the ledger.', 'STAGE_VALIDATION_FAILED');
  }
  const ignore = (await readBoundedRegularFile(path.join(root, '.gitignore'), MAX_GITIGNORE_BYTES, {
    typeCode: 'STAGE_VALIDATION_FAILED', sizeCode: 'STAGE_VALIDATION_FAILED', changedCode: 'STAGE_VALIDATION_FAILED'
  })).toString('utf8');
  invariant(/^\s*\*\s*$/m.test(ignore) || ['profile.md', 'sessions/', 'sources/', 'archive/', '.therapy/', '.scalvin/'].every((pattern) => ignore.includes(pattern)), 'Staged workspace privacy ignore rules are incomplete.', 'STAGE_VALIDATION_FAILED');
  if (options.manifest) {
    invariant(!(await clientIntegrationsNeedChange(root, options.manifest)), 'Staged client hook registration is incomplete.', 'STAGE_VALIDATION_FAILED');
  }
  return state;
}

async function validatePrivacyWorkspaceStage(root, options = {}) {
  const stateResult = await loadWorkspaceState(root, { state: { path: '.scalvin/state.json' } });
  invariant(stateResult.kind === 'current', 'Staged canonical privacy state is invalid.', 'PRIVACY_STAGE_VALIDATION_FAILED', { kind: stateResult.kind });
  const state = stateResult.state;
  if (options.expectedState) {
    invariant(JSON.stringify(state) === JSON.stringify(options.expectedState), 'Staged canonical privacy state differs from the intended transaction.', 'PRIVACY_STAGE_VALIDATION_FAILED');
  }
  const controls = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'DATA-CONTROLS.md'), MAX_CONSENT_PROJECTION_BYTES, {
    typeCode: 'PRIVACY_STAGE_VALIDATION_FAILED', sizeCode: 'PRIVACY_STAGE_VALIDATION_FAILED', changedCode: 'PRIVACY_STAGE_VALIDATION_FAILED'
  })).toString('utf8');
  invariant(consentProjectionDifferences(controls, state).length === 0, 'Staged privacy projection differs from canonical state.', 'PRIVACY_STAGE_VALIDATION_FAILED');
  if (state.consent?.eventId || state.consent?.lastOperationalEvent?.eventId) {
    const ledger = (await readBoundedRegularFile(path.join(root, '.therapy', 'state', 'CONSENT-LEDGER.md'), MAX_CONSENT_PROJECTION_BYTES, {
      typeCode: 'PRIVACY_STAGE_VALIDATION_FAILED', sizeCode: 'PRIVACY_STAGE_VALIDATION_FAILED', changedCode: 'PRIVACY_STAGE_VALIDATION_FAILED'
    })).toString('utf8');
    if (state.consent?.eventId) invariant(ledger.includes(`| ${state.consent.eventId} |`), 'Staged consent event is missing from the ledger.', 'PRIVACY_STAGE_VALIDATION_FAILED');
    if (state.consent?.lastOperationalEvent?.eventId) invariant(ledger.includes(`| ${state.consent.lastOperationalEvent.eventId} |`), 'Staged privacy-control event is missing from the ledger.', 'PRIVACY_STAGE_VALIDATION_FAILED');
  }
  return state;
}

async function loadWorkspaceState(workspace, manifest) {
  const statePath = path.resolve(workspace, manifest.state?.path || '.scalvin/state.json');
  await rejectSymlinkPath(statePath, { allowMissing: true });
  let raw;
  try {
    raw = (await readBoundedRegularFile(statePath, 4 * 1024 * 1024, {
      typeCode: 'WORKSPACE_STATE_INVALID', sizeCode: 'WORKSPACE_STATE_TOO_LARGE', changedCode: 'WORKSPACE_STATE_CHANGED'
    })).toString('utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (raw !== undefined) {
    let state;
    try {
      state = JSON.parse(raw);
    } catch (error) {
      return { kind: 'corrupt', state: null, path: statePath, error: error.message };
    }
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) return { kind: 'legacy', state, path: statePath };
    try {
      validateWorkspaceState(state);
      return { kind: 'current', state, path: statePath };
    } catch (error) {
      return { kind: 'corrupt', state, path: statePath, error: error.message, details: error.details };
    }
  }

  const legacyPath = path.resolve(workspace, '.therapy/version.json');
  await rejectSymlinkPath(legacyPath, { allowMissing: true });
  try {
    const legacyRaw = (await readBoundedRegularFile(legacyPath, 1024 * 1024, {
      typeCode: 'WORKSPACE_STATE_INVALID', sizeCode: 'WORKSPACE_STATE_TOO_LARGE', changedCode: 'WORKSPACE_STATE_CHANGED'
    })).toString('utf8');
    try {
      return { kind: 'legacy', state: JSON.parse(legacyRaw), path: legacyPath };
    } catch (error) {
      return { kind: 'corrupt', state: null, path: legacyPath, error: error.message };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', state: null, path: statePath };
    throw error;
  }
}

function migrateLegacyState(legacyResult, manifest, preferences, plan, source, options = {}) {
  const legacy = legacyResult.state || {};
  validateLegacyStateVersion(legacy);
  const now = options.now || new Date().toISOString();
  return createState(manifest, preferences, plan, source, {
    now,
    workspaceId: typeof legacy.workspaceId === 'string' ? legacy.workspaceId : options.workspaceId,
    createdAt: legacy.createdAt || now,
    consent: 'not-decided'
  });
}

const SUPPORTED_LEGACY_VERSIONS = Object.freeze(['0.8.0', '0.8.1']);

function validateLegacyStateVersion(legacy) {
  invariant(legacy && typeof legacy === 'object' && !Array.isArray(legacy), 'Legacy workspace version metadata is invalid.', 'LEGACY_VERSION_INVALID');
  const version = legacy.installed_from_version;
  invariant(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), 'Legacy workspace installed_from_version is missing or malformed.', 'LEGACY_VERSION_INVALID');
  invariant(SUPPORTED_LEGACY_VERSIONS.includes(version), 'This legacy workspace version has no verified migration adapter.', 'LEGACY_VERSION_UNSUPPORTED', { installedFromVersion: version, supported: SUPPORTED_LEGACY_VERSIONS });
  return version;
}

function validateConsentOption(value) {
  if (value === undefined) return 'not-decided';
  invariant(['not-decided', 'granted', 'declined'].includes(value), '--consent must be not-decided, granted, or declined.', 'INVALID_CONSENT', undefined);
  return value;
}

module.exports = {
  STATE_SCHEMA_VERSION,
  validateWorkspaceState,
  CONSENT_CATEGORY_SPECS,
  applyConsentChoice,
  validateRetentionPolicy,
  validateWorkspaceStage,
  validatePrivacyWorkspaceStage,
  slugify,
  normalizeLanguagePreference,
  createEmptySessionLifecycle,
  createEmptySourceLifecycle,
  validateSourceLifecycleRecord,
  validateSourceLifecyclePatch,
  applySourceLifecyclePatch,
  normalizePreferences,
  renderString,
  buildTargetPlan,
  writePlan,
  ensureWorkspaceDirectories,
  clientIntegrationsNeedChange,
  applyClientIntegrations,
  createState,
  projectDataControlsMarkdown,
  projectConsentLedgerMarkdown,
  projectConsentState,
  consentProjectionNeedsChange,
  parseDataControlsMarkdown,
  consentProjectionDifferences,
  writeState,
  loadWorkspaceState,
  migrateLegacyState,
  SUPPORTED_LEGACY_VERSIONS,
  validateLegacyStateVersion,
  validateConsentOption
};
