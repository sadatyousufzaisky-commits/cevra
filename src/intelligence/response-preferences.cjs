const { exactRecord } = require('./provider-contract.cjs');

const fields = Object.freeze({
  language: Object.freeze({ default: '', en: 'English', 'en-GB': 'British English', 'en-US': 'US English',
    es: 'Spanish', fr: 'French', de: 'German', fa: 'Persian', ps: 'Pashto', ur: 'Urdu', ar: 'Arabic', hi: 'Hindi' }),
  length: Object.freeze({ default: '', concise: 'Keep responses concise.', detailed: 'Explain reasoning and trade-offs in detail.' }),
  style: Object.freeze({ default: '', project: 'Follow the project style when it is visible in the supplied context.',
    readable: 'Prefer readable, explicit code.', minimal: 'Prefer minimal changes to the existing code.' }),
  testing: Object.freeze({ default: '', suggest: 'Suggest relevant tests for changes.', regression: 'Include regression and edge-case test suggestions.' }),
});
const keys = Object.keys(fields);
const defaults = Object.freeze(Object.fromEntries(keys.map(key => [key, 'default'])));

function responsePreferences(value, strict = false) {
  if (!exactRecord(value, keys) || !keys.every(key => typeof value[key] === 'string' && Object.hasOwn(fields[key], value[key]))) {
    if (strict) throw new Error('Choose valid response preferences.');
    return { ...defaults };
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

function preferenceMessage(value) {
  const { language, length, style, testing } = responsePreferences(value);
  return [language === 'default' ? '' : 'Respond in ' + fields.language[language] + '.',
    fields.length[length], fields.style[style], fields.testing[testing]].filter(Boolean).join('\n');
}

module.exports = { responsePreferences, preferenceMessage };
