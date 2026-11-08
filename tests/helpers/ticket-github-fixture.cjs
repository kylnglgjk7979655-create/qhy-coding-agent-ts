#!/usr/bin/env node
// GitHub CLI 外部边界夹具；状态在独立临时目录中，绝不请求真实 GitHub。
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.TICKET_FIXTURE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const send = (value) => { save(); process.stdout.write(JSON.stringify(value)); };
const fail = (message) => { save(); process.stderr.write(message); process.exit(1); };
if (args[0] !== 'api') fail('Unexpected command: ' + JSON.stringify(args));
if (args[1] === 'graphql') {
  const number = args.find((arg) => arg.startsWith('number=')).split('=')[1];
  send({ data: { repository: { issue: { parent: state.parents[number] ? { number: state.parents[number] } : null } } } });
  process.exit(0);
}
const resource = args.find((arg) => arg.startsWith('repos/')).split('/').slice(3).join('/');
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
state.requests.push({ method, resource, token: process.env.GH_TOKEN });
if (state.failNext === resource.split('?')[0] || state.failNext === method + ' ' + resource.split('?')[0]) {
  delete state.failNext; fail('fixture: API unavailable');
}
const [pathname, query] = resource.split('?');
const parts = pathname.split('/');
const params = new URLSearchParams(query);
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
if (body !== undefined) state.requests.at(-1).body = body;
const issue = state.issues[parts[1]];
const list = (values) => {
  if (!args.includes('--paginate') || !args.includes('--slurp')) fail('Pagination required');
  const pages = [];
  for (let index = 0; index < values.length; index += 100) pages.push(values.slice(index, index + 100));
  send(pages.length ? pages : [[]]);
};
if (parts[0] === 'actions') {
  send({ workflow_runs: (state.runs || []).filter((run) => run.status === params.get('status')) });
} else if (pathname === 'pulls') {
  list(state.pulls);
} else if (parts[0] === 'pulls' && parts.length === 2 && method === 'GET') {
  const pull = state.pulls.find((entry) => entry.number === Number(parts[1]));
  if (!pull) fail('Unknown pull request: ' + resource);
  send(pull);
} else if (pathname === 'issues' && method === 'GET') {
  list(Object.values(state.issues).filter((entry) => (params.get('state') === 'all' || entry.state === (params.get('state') || 'open'))
    && (!params.get('labels') || entry.labels.some((label) => label === params.get('labels')))));
} else if (pathname === 'issues' && method === 'POST') {
  const number = Math.max(...Object.values(state.issues).map((entry) => entry.number)) + 1;
  const created = { id: 1000000000 + number, number, title: body.title, body: body.body, labels: body.labels,
    state: 'open', state_reason: null, user: { login: 'github-actions[bot]' } };
  state.issues[number] = created;
  send(created);
} else if (!issue) {
  fail('Unknown issue: ' + resource);
} else if (parts.length === 2 && method === 'GET') {
  send(issue);
} else if (parts[2] === 'comments' && method === 'GET') {
  list(state.comments[issue.number] || []);
} else if (parts[2] === 'comments' && method === 'POST') {
  const comments = state.comments[issue.number] ||= [];
  const id = Math.max(0, ...Object.values(state.comments).flat().map((entry) => entry.id)) + 1;
  const created = { id, body: body.body, created_at: '2026-11-07T06:00:00Z', updated_at: '2026-11-07T06:00:00Z',
    user: { login: 'github-actions[bot]', type: 'Bot' } };
  comments.push(created); send(created);
} else if (parts[2] === 'sub_issues' && method === 'GET') {
  list(Object.entries(state.parents).filter(([, parent]) => parent === issue.number).map(([child]) => state.issues[child]));
} else if (parts[2] === 'sub_issues' && method === 'POST') {
  const child = Object.values(state.issues).find((entry) => entry.id === body.sub_issue_id);
  if (!child) fail('sub_issue_id must be a REST integer ID');
  state.parents[child.number] = issue.number; send(child);
} else if (parts[2] === 'dependencies' && method === 'GET') {
  list(parts[3] === 'blocking'
    ? Object.entries(state.blockers).filter(([, blockers]) => blockers.includes(issue.number)).map(([number]) => state.issues[number])
    : (state.blockers[issue.number] || []).map((number) => state.issues[number]));
} else if (parts[2] === 'dependencies' && method === 'POST') {
  const blocker = Object.values(state.issues).find((entry) => entry.id === body.issue_id);
  if (!blocker) fail('issue_id must be a REST integer ID');
  (state.blockers[issue.number] ||= []).push(blocker.number); send(blocker);
} else if (parts[2] === 'labels' && method === 'POST') {
  issue.labels = [...new Set([...issue.labels, ...body.labels])]; send(issue.labels);
} else if (parts[2] === 'labels' && method === 'DELETE') {
  issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(parts[3])); send(issue.labels);
} else fail('Unexpected API: ' + method + ' ' + resource);
