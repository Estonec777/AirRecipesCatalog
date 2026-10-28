import {readFileSync} from 'node:fs';

// Only the fixed catalog.json path is ever written; issue content is treated as data.
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const repo = process.env.GITHUB_REPOSITORY;
const marker = '<!-- AIRRECIPES_PUBLISH_V1 -->';
if (repo !== 'Estonec777/AirRecipesCatalog' || event.action !== 'opened' ||
    event.sender?.login !== 'Estonec777' || event.issue?.user?.login !== 'Estonec777' ||
    typeof event.issue.body !== 'string' || !event.issue.body.startsWith(marker)) {
  throw Error('Not an authorized publishing request.');
}

const match = event.issue.body.match(/^<!-- AIRRECIPES_PUBLISH_V1 -->\s*```json\s*([\s\S]*?)\s*```/);
if (!match || match[1].length > 30000) throw Error('Invalid publishing payload.');
const data = JSON.parse(match[1]);
if (data.action !== 'upsert' || !data.recipe || typeof data.recipe !== 'object' || Array.isArray(data.recipe)) {
  throw Error('Unsupported operation.');
}

const r = data.recipe;
const validString = (s, max = 10000) => typeof s === 'string' && s.length <= max;
const requireString = (s, max) => validString(s, max) && s.trim().length > 0;
if (!/^online-[a-z0-9][a-z0-9-]{2,100}$/.test(r.id) ||
    !requireString(r.title, 140) || !requireString(r.category, 80) ||
    !requireString(r.ingredients, 10000) || !Array.isArray(r.steps) ||
    r.steps.length < 1 || r.steps.length > 60 || r.steps.some(s => !requireString(s, 2000)) ||
    !/^\d{1,3}$/.test(r.duration) || Number(r.duration) < 1 || Number(r.duration) > 600 ||
    !Number.isInteger(r.servings) || r.servings < 1 || r.servings > 100 ||
    !validString(r.description, 5000) || !validString(r.photo, 400) ||
    (r.temperature !== '' && (!/^\d{1,3}$/.test(r.temperature) || Number(r.temperature) < 50 || Number(r.temperature) > 250)) ||
    (r.photo && !/^https:\/\/raw\.githubusercontent\.com\/Estonec777\/AirRecipesCatalog\/main\/images\/[A-Za-z0-9_-]+\.webp$/.test(r.photo))) {
  throw Error('Recipe fields failed validation.');
}
if (r.sourceLanguage !== 'uk' || r.favorite !== false) throw Error('Invalid recipe defaults.');
if (r.zones) {
  if (r.zones.mode !== 'single' || Boolean(r.zones.left) === Boolean(r.zones.right)) throw Error('Invalid basket mode.');
  const basket = r.zones.left ?? r.zones.right;
  if (basket.food !== r.title || !Number.isInteger(basket.temperatureC) || basket.temperatureC < 50 || basket.temperatureC > 250 ||
      !Number.isInteger(basket.minutes) || basket.minutes < 1 || basket.minutes > 600) throw Error('Invalid basket settings.');
}

// Do not let issue authors add arbitrary fields, HTML URLs or prototype-bearing structures.
const allowed = new Set(['id','title','ingredients','steps','duration','temperature','description','photo','favorite','category','servings','sourceLanguage','zones','nutritionOverride']);
if (Object.keys(r).some(key => !allowed.has(key))) throw Error('Unexpected recipe field.');
if (r.nutritionOverride) {
  if (Object.keys(r.nutritionOverride).sort().join(',') !== 'calories,carbs,fat,protein' ||
      Object.values(r.nutritionOverride).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000)) {
    throw Error('Invalid nutrition data.');
  }
}

const api = `https://api.github.com/repos/${repo}/contents/catalog.json`;
const headers = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};
if (r.photo) {
  const imageName = r.photo.slice(r.photo.lastIndexOf('/') + 1);
  const imageCheck = await fetch(`https://api.github.com/repos/${repo}/contents/images/${imageName}`, {headers});
  if (!imageCheck.ok) throw Error('Photo must be uploaded to images/ before publishing.');
  const imageInfo = await imageCheck.json();
  if (imageInfo.type !== 'file' || imageInfo.size > 1024 * 1024) throw Error('Image is not a valid WebP of at most 1 MB.');
}
const response = await fetch(api, {headers});
if (!response.ok) throw Error(`Cannot read catalog: HTTP ${response.status}`);
const file = await response.json();
const catalog = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
if (catalog.schemaVersion !== 1 || !Number.isSafeInteger(catalog.catalogVersion) ||
    !Array.isArray(catalog.recipes) || !Array.isArray(catalog.deletedIds)) throw Error('Invalid live catalog.');
if (catalog.deletedIds.includes(r.id)) throw Error('Cannot republish a deleted ID.');
const index = catalog.recipes.findIndex(old => old.id === r.id);
if (index >= 0) catalog.recipes[index] = r;
else catalog.recipes.push(r);
catalog.catalogVersion += 1;

const update = await fetch(api, {
  method: 'PUT', headers,
  body: JSON.stringify({
    message: `Publish recipe ${r.id} (issue #${event.issue.number})`,
    content: Buffer.from(JSON.stringify(catalog, null, 2) + '\n').toString('base64'),
    sha: file.sha,
  }),
});
if (!update.ok) throw Error(`Catalog update failed: HTTP ${update.status} ${await update.text()}`);
console.log(`Published ${r.id}; catalogVersion=${catalog.catalogVersion}`);
