// UI。左にナビ＋絞り込み、中央に一覧、右に詳細。
//
// 表示の原則（C-07）:
//   - 有効／除外を断定しない。関連度は順位として出す
//   - 未採点は「未採点 n 件」と実数で出す。推定しない
//   - 失敗は黙らず出す
//   - 破壊的な操作（削除）は確認を取る

import type { Api } from '../preload/index.js';
import { PdfViewer } from './pdf-view.js';

declare global {
  interface Window {
    api: Api;
  }
}

type ReadStatus = 'unread' | 'reading' | 'read';

interface ReferenceRow {
  reference_id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  url: string | null;
  abstract: string | null;
  starred: number;
  read_status: ReadStatus;
  bibtex_key: string;
  tags: string[];
  has_note: number;
  attachment_count: number;
}

interface RankedPaper {
  paper_id: string;
  external_id: string | null;
  title: string;
  authors: string | null;
  abstract: string | null;
  url: string | null;
  published_at: string | null;
  relevance: number | null;
  sim_summary: number | null;
  nearest_chunk_text: string | null;
  nearest_chunk_sim: number | null;
  in_library: number;
  problem_excerpt: string | null;
  venue?: string | null;
  item_type?: string | null;
  pdf_url?: string | null;
  fulltext_path?: string | null;
}

interface SurveyReport {
  run_id: string;
  project_id: string;
  run_date: string;
  status: string;
  search_terms: string | null;
  trend: string | null;
  themes_json: string | null;
  created_at: string;
  paper_count: number;
}

interface MypaperFile {
  path: string;
  name: string;
  ext: string;
  kind: 'manuscript' | 'pdf';
  bytes: number;
  mtime: string;
}

interface Attachment {
  attachment_id: string;
  path: string;
  kind: string;
}

/** papers.published_at（YYYY-MM-DD）から年。形が崩れていたら出さない（C-07） */
function yearFromPublishedAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const y = Number(String(raw).slice(0, 4));
  return Number.isInteger(y) && y >= 1000 && y <= 2100 ? y : null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function on(id: string, type: string, fn: EventListenerOrEventListenerObject): void {
  document.getElementById(id)?.addEventListener(type, fn);
}
/**
 * 要素を作る小さなヘルパ。
 * `class` / `style` / `data-*` / `aria-*` は属性として、それ以外はプロパティとして設定する。
 * innerHTML を使わないので、文字列がそのままマークアップとして解釈されることがない。
 */
type ElProps = Record<string, unknown> & { class?: string; style?: string };

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') n.className = String(v);
    else if (k === 'style' || k.startsWith('data-') || k.startsWith('aria-') || k === 'title' || k === 'role')
      n.setAttribute(k, String(v));
    else (n as unknown as Record<string, unknown>)[k] = v;
  }
  n.append(...kids);
  return n;
};

const READ_LABEL: Record<ReadStatus, string> = {
  unread: '未読',
  reading: '読んでいる',
  read: '読んだ',
};

let projectId = '';
let projectRoot: string | null = null;
let signedIn = false;
let libFilter: 'all' | 'starred' | ReadStatus = 'all';
let libTag: string | null = null;
let selectedRef: string | null = null;
let selectedPaper: string | null = null;
let selectedRunId: string | null = null;
let selectedMypaper: string | null = null;
/** 読む順の採点式。一覧コールアウトと詳細ラベルで共有 */
let lastScoreMode: 'mypaper' | 'blend' = 'blend';
let viewer: PdfViewer | null = null;
/** 設定で確認するキーワード。関連技術・検索語になる */
let keywordTags: string[] = [];

/** PDF ビューアの入出力。レンダラに fs を持たせず、すべて preload 経由にする */
const viewerHost = {
  readAttachment: (id: string) =>
    window.api.pdf.read(id) as Promise<{ path: string; data: Uint8Array }>,
  listAnnotations: (id: string) => window.api.anno.list(id) as Promise<never[]>,
  addHighlight: (id: string, a: unknown) => window.api.anno.addHighlight(id, a) as Promise<string>,
  addInk: (id: string, a: unknown) => window.api.anno.addInk(id, a) as Promise<string>,
  setComment: (id: string, c: string) => window.api.anno.comment(id, c) as Promise<void>,
  removeAnnotation: (id: string) => window.api.anno.remove(id) as Promise<void>,
  onError: (m: string) => setStatus(m, 'error'),
  // 書き込みが増減したら一覧の印だけ更新する。
  // ここで詳細ペインを描き直すとビューア自体が消える
  onChange: () => void refreshLibrary(),
};

// --- 状態表示 ----------------------------------------------------------------

function setStatus(text: string, tone: 'info' | 'error' | 'busy' = 'info') {
  const s = document.getElementById('status');
  if (s) {
    s.textContent = text;
    s.setAttribute('data-tone', tone);
  }
  const welcome = document.getElementById('welcome');
  const welcomeErr = document.getElementById('welcome-error');
  if (welcomeErr && welcome && !welcome.hidden) {
    welcomeErr.hidden = !text;
    welcomeErr.textContent = text;
    welcomeErr.setAttribute('data-tone', tone);
  }
  const settings = document.getElementById('settings') as HTMLDialogElement | null;
  const settingsStatus = document.getElementById('settings-status');
  if (settingsStatus) {
    const show = Boolean(text) && Boolean(settings?.open);
    settingsStatus.hidden = !show;
    if (show) {
      settingsStatus.textContent = text;
      settingsStatus.setAttribute('data-tone', tone);
    }
  }
}

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    // 失敗を黙って握りつぶさない（C-07）
    setStatus(what + 'に失敗: ' + (e instanceof Error ? e.message : String(e)), 'error');
    return undefined;
  }
}

async function createFromWelcome(): Promise<void> {
  const title = ($('welcome-title') as HTMLInputElement | null)?.value.trim() ?? '';
  const btn = $('welcome-create') as HTMLButtonElement | null;
  if (!title) {
    setStatus('プロジェクト名を入れてください', 'error');
    ($('welcome-title') as HTMLInputElement | null)?.focus();
    return;
  }
  if (btn) btn.disabled = true;
  setStatus('プロジェクトを作っています…', 'busy');
  try {
    const res = await window.api.createUnderRecycle(title);
    if (!res.ok) {
      setStatus(res.error ?? 'プロジェクトを作れなかった', 'error');
      return;
    }
    const projects = ((await window.api.listProjects()) ?? []) as ProjectRow[];
    const p = projects.find((x) => x.root_path === res.root) ?? projects[0];
    if (!p) {
      setStatus('プロジェクトを作れなかった', 'error');
      return;
    }
    setStatus(`「${res.title}」を ~/Recycle に作った`);
    await enterApp({ ...p, title: res.title, root_path: res.root }, { forceSettings: true });
  } catch (e) {
    setStatus('プロジェクトの作成に失敗: ' + (e instanceof Error ? e.message : String(e)), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

on('welcome-create', 'click', () => {
  void createFromWelcome();
});
on('welcome-title', 'keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    void createFromWelcome();
  }
});

// --- タブ --------------------------------------------------------------------

for (const id of ['feed', 'library', 'mypaper'] as const) {
  on(`tab-${id}`, 'click', () => {
    showTab(id);
  });
}

function showTab(id: 'feed' | 'library' | 'mypaper'): void {
  for (const other of ['feed', 'library', 'mypaper'] as const) {
    const active = other === id;
    document.getElementById(`tab-${other}`)?.setAttribute('aria-selected', String(active));
    document.getElementById(`view-${other}`)?.setAttribute('data-active', String(active));
    const nav = document.getElementById(`nav-${other}`);
    if (nav) nav.hidden = !active;
  }
  if (id === 'library') void refreshLibrary();
  if (id === 'feed') void refreshFeed();
  if (id === 'mypaper') void refreshMypaper();
}

function settingsDialog(): HTMLDialogElement {
  return $('settings') as HTMLDialogElement;
}

function openSettings(): void {
  if ($('shell').hidden) return;
  const dlg = settingsDialog();
  const show = () => {
    if (!dlg.open) dlg.showModal();
    ($('summary') as HTMLTextAreaElement).focus();
    void maybeInferKeywords();
  };
  // shell を出した直後だと dialog が描画されないことがある
  requestAnimationFrame(() => requestAnimationFrame(show));
}

function closeSettings(): void {
  const dlg = settingsDialog();
  if (dlg.open) dlg.close();
}

function setKeywordTags(next: string[]): void {
  const seen = new Set<string>();
  keywordTags = [];
  for (const raw of next) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywordTags.push(t);
  }
  renderKeywordTags();
}

function renderKeywordTags(): void {
  const box = document.getElementById('keyword-tags');
  if (!box) return;
  box.replaceChildren();
  if (keywordTags.length === 0) {
    box.append(el('p', { class: 'note-info' }, 'キーワード未設定'));
    return;
  }
  for (const t of keywordTags) {
    const remove = el('button', { type: 'button', 'aria-label': `${t} を外す` }, '×');
    remove.addEventListener('click', () => {
      setKeywordTags(keywordTags.filter((x) => x.toLowerCase() !== t.toLowerCase()));
    });
    box.append(el('span', { class: 'chip', 'data-tone': 'tag' }, t, remove));
  }
}

function addKeywordFromInput(): void {
  const input = $('keyword-add') as HTMLInputElement | null;
  if (!input) return;
  const t = input.value.trim();
  if (!t) return;
  setKeywordTags([...keywordTags, t]);
  input.value = '';
  input.focus();
}

async function inferKeywordsFromSummary(force = false): Promise<void> {
  const summary = ($('summary') as HTMLTextAreaElement | null)?.value.trim() ?? '';
  if (!summary) {
    setStatus('先に課題意識を書いてください', 'error');
    ($('summary') as HTMLTextAreaElement | null)?.focus();
    return;
  }
  if (!signedIn) {
    setStatus('キーワードの推測にはログインが必要です', 'error');
    return;
  }
  if (!force && keywordTags.length > 0) return;
  if (!window.api.inferKeywords) {
    setStatus('この版ではキーワード推測が使えません。アプリを開き直してください', 'error');
    return;
  }
  const btn = $('keyword-infer') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setStatus('課題意識からキーワードを推測しています…', 'busy');
  const res = await guard('キーワードの推測', () => window.api.inferKeywords(summary));
  if (btn) btn.disabled = false;
  if (!res) return;
  setKeywordTags(res.terms);
  if (res.terms.length === 0) {
    setStatus('キーワードを出せなかった。手で足してください', 'error');
    return;
  }
  setStatus(`${res.terms.length} 件を出した。合わないものは × で外してください`);
}

async function maybeInferKeywords(): Promise<void> {
  if (keywordTags.length > 0) return;
  const summary = ($('summary') as HTMLTextAreaElement | null)?.value.trim() ?? '';
  if (!summary || !signedIn) return;
  await inferKeywordsFromSummary(false);
}

/** 収集に必要な最低限（課題意識＋ログイン）が揃っていなければ未設定 */
function needsSettings(p: { summary: string }, loggedIn = signedIn): boolean {
  return !p.summary.trim() || !loggedIn;
}

function settingsDoneKey(id: string): string {
  return `ai-research:settings-done:${id}`;
}

function hasCompletedSettings(projectId: string): boolean {
  try {
    return localStorage.getItem(settingsDoneKey(projectId)) === '1';
  } catch {
    return false;
  }
}

function markSettingsCompleted(projectId: string): void {
  try {
    localStorage.setItem(settingsDoneKey(projectId), '1');
  } catch {
    /* ignore */
  }
}

function currentSettingsSnapshot(): { summary: string } {
  return { summary: ($('summary') as HTMLTextAreaElement).value };
}

// --- ライブラリ：一覧 ---------------------------------------------------------

function currentFilter() {
  const f: Record<string, unknown> = {
    query: ($('lib-search') as HTMLInputElement).value.trim() || undefined,
    sort: ($('lib-sort') as HTMLSelectElement).value,
  };
  if (libFilter === 'starred') f.starred = true;
  else if (libFilter !== 'all') f.readStatus = libFilter;
  if (libTag) f.tag = libTag;
  return f;
}

async function refreshLibrary() {
  const counts = (await guard('件数の取得', () => window.api.lib.counts(projectId))) as
    | { total: number; starred: number; unread: number; reading: number; read: number }
    | undefined;
  if (counts) {
    $('count-all').textContent = String(counts.total);
    $('count-starred').textContent = String(counts.starred);
    $('count-unread').textContent = String(counts.unread);
    $('count-reading').textContent = String(counts.reading);
    $('count-read').textContent = String(counts.read);
  }

  const tags = ((await guard('タグの取得', () => window.api.lib.tags(projectId))) ?? []) as {
    name: string;
    count: number;
  }[];
  const tagBox = $('tag-list');
  tagBox.replaceChildren();
  if (tags.length === 0) {
    tagBox.append(el('p', { class: 'note-info' }, 'まだタグはありません。'));
  }
  for (const t of tags) {
    const b = el(
      'button',
      { class: 'side-item', 'aria-pressed': String(libTag === t.name) },
      el('span', {}, t.name),
      el('span', { class: 'side-count' }, String(t.count)),
    );
    b.addEventListener('click', () => {
      libTag = libTag === t.name ? null : t.name;
      void refreshLibrary();
    });
    tagBox.append(b);
  }

  const rows = ((await guard('一覧の取得', () => window.api.lib.list(projectId, currentFilter()))) ??
    []) as ReferenceRow[];

  const list = $('lib-list');
  list.replaceChildren();

  if (rows.length === 0) {
    const none = counts && counts.total === 0;
    list.append(
      el(
        'div',
        { class: 'empty-state' },
        el('p', { class: 'empty-title' }, none ? '文献はまだありません' : '条件に合う文献がありません'),
        el(
          'p',
          { class: 'empty' },
          none
            ? '報告から入れるか、右上の PDF / 追加で入れます。'
            : '絞り込みや検索を変えてみてください。',
        ),
      ),
    );
    // ここで詳細ペインを触らない。PDF ビューアを開いていると消えてしまう
    if (selectedRef && !rows.some((x) => x.reference_id === selectedRef)) {
      selectedRef = null;
      showEmptyDetail();
    }
    return;
  }

  for (const r of rows) {
    const marks = el('span', { class: 'row-marks' });
    if (r.starred) marks.append(el('span', { class: 'chip' }, '★'));
    if (r.has_note) marks.append(el('span', { class: 'chip' }, 'メモ'));
    if (r.attachment_count > 0) marks.append(el('span', { class: 'chip' }, `PDF ${r.attachment_count}`));

    const meta = el(
      'span',
      { class: 'row-meta' },
      el('span', {}, [r.authors ?? '著者不明', r.year ?? '年不明'].join(' / ')),
      el('span', { class: 'chip', 'data-tone': r.read_status }, READ_LABEL[r.read_status]),
      ...r.tags.map((t) => el('span', { class: 'chip', 'data-tone': 'tag' }, t)),
      marks,
    );

    const row = el(
      'button',
      {
        class: 'row',
        'aria-current': String(selectedRef === r.reference_id),
        'data-ref': r.reference_id,
      },
      el('span', { class: 'row-title' }, r.title),
      meta,
    );
    row.addEventListener('click', () => void selectReference(r.reference_id));
    list.append(row);
  }

  // **詳細ペインはここで描き直さない。**
  // ビューアを開いている最中に描き直すと、PDF ごと作り直されて操作が飛ぶ。
  // 選択が消えたときだけ空表示に戻す
  if (selectedRef && !rows.some((r) => r.reference_id === selectedRef)) {
    selectedRef = null;
    showEmptyDetail();
  }
}

/** 一覧の選択を現在の selectedRef に合わせる（再描画はしない） */
function syncRowSelection(): void {
  for (const row of document.querySelectorAll<HTMLElement>('#lib-list .row')) {
    row.setAttribute('aria-current', String(row.dataset.ref === selectedRef));
  }
}

function showEmptyDetail(): void {
  closeViewer();
  const pane = $('lib-detail');
  pane.replaceChildren(
    el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-title' }, '文献を選ぶ'),
      el('p', { class: 'empty' }, '左の一覧から文献を選ぶと、書誌と PDF がここに開きます。'),
    ),
  );
}

/**
 * 文献を選んだときの入口。
 * **PDF があればまずビューアを開く。**書誌情報はボタンで開く
 */
async function selectReference(referenceId: string): Promise<void> {
  selectedRef = referenceId;
  syncRowSelection();

  const attachments = ((await guard('添付の取得', () => window.api.lib.attachments(referenceId))) ??
    []) as Attachment[];

  if (attachments.length > 0) {
    const r = (await guard('文献の取得', () => window.api.lib.get(referenceId))) as
      | ReferenceRow
      | undefined;
    await openInViewer(attachments[0]!.attachment_id, r?.title ?? '');
  } else {
    await renderRefDetail(referenceId);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.side-item[data-filter]')) {
  b.addEventListener('click', () => {
    libFilter = b.dataset.filter as typeof libFilter;
    for (const other of document.querySelectorAll('.side-item[data-filter]')) {
      other.setAttribute('aria-pressed', String(other === b));
    }
    void refreshLibrary();
  });
}

$('lib-search').addEventListener('input', () => void refreshLibrary());
$('lib-sort').addEventListener('change', () => void refreshLibrary());

// --- ライブラリ：詳細 ---------------------------------------------------------

async function renderRefDetail(referenceId: string | null) {
  // 書誌情報に切り替えるときは必ずビューアを畳む。
  // 残したまま DOM を差し替えると pdf.js のワーカーが宙に浮く
  closeViewer();

  const pane = $('lib-detail');
  pane.replaceChildren();

  if (!referenceId) {
    showEmptyDetail();
    return;
  }

  const r = (await guard('文献の取得', () => window.api.lib.get(referenceId))) as
    | ReferenceRow
    | undefined;
  if (!r) {
    pane.append(el('p', { class: 'empty' }, 'この文献は見つかりませんでした。'));
    return;
  }

  // PDF があるなら、まずそこへ戻れるようにする（既定の表示はビューア）
  const attachmentsForHead = ((await guard('添付の取得', () =>
    window.api.lib.attachments(r.reference_id))) ?? []) as Attachment[];
  if (attachmentsForHead.length > 0) {
    const toViewer = el('button', { class: 'btn', 'data-variant': 'primary' }, '← PDF を読む');
    toViewer.addEventListener('click', () => {
      void openInViewer(attachmentsForHead[0]!.attachment_id, r.title);
    });
    pane.append(el('div', { class: 'actions' }, toViewer));
  }

  pane.append(el('h2', { class: 'detail-title' }, r.title));
  pane.append(
    el(
      'p',
      { class: 'detail-meta' },
      [r.authors, r.venue, r.year ? String(r.year) : null].filter(Boolean).join(' / ') || '書誌情報なし',
    ),
  );

  // 印
  const star = el('button', {
    class: 'icon-btn',
    'aria-pressed': String(!!r.starred),
    title: r.starred ? '重要を外す' : '重要にする',
  }, r.starred ? '★' : '☆');
  star.addEventListener('click', async () => {
    await guard('印の変更', () => window.api.lib.star(r.reference_id, !r.starred));
    await refreshLibrary();
    await renderRefDetail(r.reference_id);
  });

  const sel = el('select', { style: 'width:auto;min-width:160px' }) as HTMLSelectElement;
  for (const s of ['unread', 'reading', 'read'] as ReadStatus[]) {
    sel.append(el('option', { value: s, selected: r.read_status === s }, READ_LABEL[s]));
  }
  sel.addEventListener('change', async () => {
    await guard('読了状態の変更', () => window.api.lib.readStatus(r.reference_id, sel.value));
    await refreshLibrary();
  });

  pane.append(
    el(
      'div',
      { class: 'actions' },
      star,
      el('label', { class: 'visually-hidden', htmlFor: 'read-sel' }, '読了状態') as HTMLLabelElement,
      sel,
      el('span', { class: 'chip' }, '@' + r.bibtex_key),
    ),
  );

  // タグ
  const tagSec = el('div', { class: 'detail-section' }, el('h3', {}, 'タグ'));
  const tagRow = el('div', { class: 'actions' });
  for (const t of r.tags) {
    const chip = el('span', { class: 'chip', 'data-tone': 'tag' }, t);
    const x = el('button', { title: `タグ「${t}」を外す`, 'aria-label': `タグ「${t}」を外す` }, '×');
    x.addEventListener('click', async () => {
      await guard('タグの削除', () => window.api.lib.removeTag(r.reference_id, t));
      await refreshLibrary();
      await renderRefDetail(r.reference_id);
    });
    chip.append(x);
    tagRow.append(chip);
  }
  const tagInput = el('input', {
    type: 'text',
    placeholder: 'タグを追加して Enter',
    style: 'width:200px',
  }) as HTMLInputElement;
  tagInput.addEventListener('keydown', async (ev) => {
    if ((ev as KeyboardEvent).key !== 'Enter' || !tagInput.value.trim()) return;
    await guard('タグの追加', () => window.api.lib.addTag(projectId, r.reference_id, tagInput.value));
    tagInput.value = '';
    await refreshLibrary();
    await renderRefDetail(r.reference_id);
  });
  tagRow.append(tagInput);
  tagSec.append(tagRow);
  pane.append(tagSec);

  // 要旨
  if (r.abstract) {
    pane.append(
      el('div', { class: 'detail-section' }, el('h3', {}, '要旨'), el('p', { class: 'abstract' }, r.abstract)),
    );
  }

  // メモ
  const noteSec = el('div', { class: 'detail-section' }, el('h3', {}, 'メモ'));
  const note = el('textarea', { rows: 8, placeholder: '読んで考えたことを書く。外に出ません。' }) as HTMLTextAreaElement;
  note.value = ((await guard('メモの取得', () => window.api.lib.getNote(r.reference_id))) ?? '') as string;
  const noteInfo = el('p', { class: 'note-info' }, '');
  let timer: number | undefined;
  note.addEventListener('input', () => {
    window.clearTimeout(timer);
    noteInfo.textContent = '入力中…';
    // 自動保存。保存し損ねを「保存済み」に見せない
    timer = window.setTimeout(async () => {
      const ok = await guard('メモの保存', () => window.api.lib.saveNote(r.reference_id, note.value));
      noteInfo.textContent = ok === undefined ? '' : '保存した ' + new Date().toLocaleTimeString('ja-JP');
      void refreshLibrary();
    }, 600);
  });
  noteSec.append(note, noteInfo);
  pane.append(noteSec);

  // 添付
  const atSec = el('div', { class: 'detail-section' }, el('h3', {}, '添付 PDF'));
  const attachments = ((await guard('添付の取得', () => window.api.lib.attachments(r.reference_id))) ??
    []) as Attachment[];
  if (attachments.length === 0) {
    atSec.append(el('p', { class: 'note-info' }, '添付はありません。'));
  }
  for (const a of attachments) {
    const open = el('button', { class: 'btn', 'data-variant': 'primary' }, 'この中で読む');
    open.addEventListener('click', () => void openInViewer(a.attachment_id, r.title));


    const ext = el('button', { class: 'btn', 'data-variant': 'tertiary' }, '外部で開く');
    ext.addEventListener('click', async () => {
      const err = await window.api.lib.openExternally(a.path);
      if (err) setStatus('PDF を開けなかった: ' + String(err), 'error');
    });

    const del = el('button', { class: 'btn', 'data-variant': 'tertiary' }, '外す');
    del.addEventListener('click', async () => {
      if (!window.confirm('この添付を一覧から外します。PDF ファイル自体は消えません。')) return;
      await guard('添付の削除', () => window.api.lib.removeAttachment(a.attachment_id));
      await renderRefDetail(r.reference_id);
      await refreshLibrary();
    });

    atSec.append(
      el('div', { class: 'attachment' }, el('span', { class: 'path' }, a.path), open, ext, del),
    );
  }

  if (attachments.length > 0) {
    const c = (await guard('書き込み件数の取得', () => window.api.anno.counts(r.reference_id))) as
      | { highlights: number; inks: number; comments: number }
      | undefined;
    if (c && c.highlights + c.inks + c.comments > 0) {
      atSec.append(
        el(
          'div',
          { class: 'actions', style: 'margin-top:8px' },
          el('span', { class: 'chip' }, `ハイライト ${c.highlights}`),
          el('span', { class: 'chip' }, `ペン ${c.inks}`),
          el('span', { class: 'chip' }, `コメント ${c.comments}`),
        ),
      );
    }
  }
  const attach = el('button', { class: 'btn', 'data-variant': 'secondary' }, 'PDF を添付');
  attach.addEventListener('click', async () => {
    const id = await guard('PDF の添付', () => window.api.lib.attachFile(r.reference_id));
    if (id) {
      await renderRefDetail(r.reference_id);
      await refreshLibrary();
    }
  });
  atSec.append(el('div', { class: 'actions', style: 'margin-top:12px' }, attach));
  atSec.append(
    el(
      'p',
      { class: 'note-info' },
      'PDF の実体は移動もコピーもしません。「外す」を押してもファイルは消えません。',
    ),
  );
  pane.append(atSec);

  // 公開書誌の穴埋め。Worker の BFF 経由。原稿は送らない
  if (r.title || r.doi) {
    const lookup = el('button', { class: 'btn', 'data-variant': 'secondary' }, '書誌を補う');
    lookup.addEventListener('click', async () => {
      if (
        !window.confirm(
          `公開書誌をクラウド経由で補います。OA の PDF があれば references/ に置きます。
手元の原稿やメモは送りません。続けますか。`,
        )
      )
        return;
      const got = await guard('書誌の取得', () => window.api.lib.follow(projectId, r.reference_id));
      if (!got) return;
      setStatus('書誌を補った' + citeExportWarning(got.cite === 'conflict'));
      await refreshLibrary();
      await renderRefDetail(r.reference_id);
    });
    pane.append(
      el(
        'div',
        { class: 'detail-section' },
        el('h3', {}, '書誌の補完'),
        el('p', { class: 'detail-meta' }, r.doi ?? r.title),
        el('div', { class: 'actions' }, lookup),
        el('p', { class: 'note-info' }, '押したときだけクラウドに問い合わせます。既定では何も送りません。'),
      ),
    );
  }

  // 削除（ターシャリーは左端、危険な操作は明示）
  const del = el('button', { class: 'btn', 'data-variant': 'danger' }, 'この文献を削除');
  del.addEventListener('click', async () => {
    if (!window.confirm(`「${r.title}」を削除します。メモと添付の記録も消えます。取り消せません。`)) return;
    await guard('削除', () => window.api.lib.remove(r.reference_id));
    selectedRef = null;
    await refreshLibrary();
    await renderRefDetail(null);
    setStatus('削除した');
  });
  pane.append(el('div', { class: 'detail-section actions' }, del));
}

// --- PDF ビューア --------------------------------------------------------------

function closeViewer(): void {
  viewer?.close();
  viewer = null;
  // 読み終わったら一覧に幅を戻す
  $('shell').removeAttribute('data-reading');
}

/**
 * 詳細ペインを PDF ビューアにする。
 * 文献を選んだときの既定の表示（書誌情報はボタンで開く）
 */
async function openInViewer(attachmentId: string, title: string): Promise<void> {
  closeViewer();
  // 読んでいる間は本文に幅を回す
  $('shell').setAttribute('data-reading', 'true');

  const pane = $('lib-detail');
  pane.replaceChildren();

  const info = el('button', { class: 'btn', 'data-variant': 'secondary' }, '書誌情報とメモ');
  info.addEventListener('click', () => {
    void renderRefDetail(selectedRef);
  });

  pane.append(
    el(
      'div',
      { class: 'actions viewer-head' },
      el('h2', { class: 'detail-title viewer-title' }, title),
      el('span', { class: 'spacer' }),
      info,
    ),
  );

  const box = el('div', {});
  pane.append(box);

  viewer = new PdfViewer(box, viewerHost);
  await viewer.open(attachmentId);
}

// --- ライブラリ：追加フォーム --------------------------------------------------

$('lib-new').addEventListener('click', () => {
  const pane = $('lib-detail');
  pane.replaceChildren();
  pane.append(el('h2', { class: 'detail-title' }, '文献を追加'));

  const mk = (id: string, label: string, hint?: string, type = 'text') => {
    const input = el('input', { type, id }) as HTMLInputElement;
    const f = el('div', { class: 'field' }, el('label', { htmlFor: id }, label));
    if (hint) f.append(el('p', { class: 'hint' }, hint));
    f.append(input);
    return { field: f, input };
  };

  const title = mk('f-title', 'タイトル（必須）');
  const authors = mk('f-authors', '著者', '「姓 名; 姓 名」の形で入れると引用キーを作れます');
  const year = mk('f-year', '出版年', undefined, 'number');
  const venue = mk('f-venue', '掲載誌・会議');
  const doi = mk('f-doi', 'DOI', '同じ DOI は二重登録できません');
  const url = mk('f-url', 'URL');

  const abs = el('textarea', { id: 'f-abstract', rows: 6 }) as HTMLTextAreaElement;
  const absField = el(
    'div',
    { class: 'field' },
    el('label', { htmlFor: 'f-abstract' }, '要旨'),
    abs,
  );

  pane.append(title.field, el('div', { class: 'grid-2' }, authors.field, year.field));
  pane.append(el('div', { class: 'grid-2' }, venue.field, doi.field));
  pane.append(url.field, absField);

  const cancel = el('button', { class: 'btn', 'data-variant': 'tertiary' }, 'やめる');
  cancel.addEventListener('click', () => void renderRefDetail(selectedRef));

  const save = el('button', { class: 'btn', 'data-variant': 'primary' }, '保存する');
  save.addEventListener('click', async () => {
    if (!title.input.value.trim()) {
      setStatus('タイトルは必須です', 'error');
      title.input.focus();
      return;
    }
    setStatus('保存して PDF を取得しています…', 'busy');
    const res = await guard('保存', () =>
      window.api.lib.add(projectId, {
        title: title.input.value.trim(),
        authors: authors.input.value.trim() || null,
        year: year.input.value ? Number(year.input.value) : null,
        venue: venue.input.value.trim() || null,
        doi: doi.input.value.trim() || null,
        url: url.input.value.trim() || null,
        abstract: abs.value.trim() || null,
      }),
    );
    if (!res) return;
    selectedRef = res.reference_id;
    setStatus(libraryAddStatus(res.pdf, res.citeConflict));
    await refreshLibrary();
    await renderRefDetail(selectedRef);
  });

  // デスクトップはプライマリーを右端、ターシャリーを左端に（DADS）
  pane.append(el('div', { class: 'actions' }, cancel, el('span', { class: 'spacer' }), save));
});

// --- PDF から取り込む ----------------------------------------------------------

$('lib-import-pdf').addEventListener('click', async () => {
  setStatus('PDF を読み込んでいます…', 'busy');

  const res = (await guard('PDF の取り込み', () => window.api.pdf.import(projectId))) as
    | {
        imported: { reference_id: string; title: string; path: string; guessed: boolean; doi: string | null }[];
        failed: { path: string; error: string }[];
      }
    | undefined;

  if (!res) return;

  if (res.imported.length === 0 && res.failed.length === 0) {
    setStatus('取り込みを中止した');
    return;
  }

  await refreshLibrary();

  // 何が入って何が失敗したかを必ず出す（C-07）
  const pane = $('lib-detail');
  pane.replaceChildren();
  pane.append(el('h2', { class: 'detail-title' }, '取り込み結果'));
  pane.append(
    el(
      'p',
      { class: 'detail-meta' },
      `取り込んだ ${res.imported.length} 件 / 失敗 ${res.failed.length} 件`,
    ),
  );

  if (res.imported.length === 1 && res.failed.length === 0) {
    // 1 件だけなら結果表示を挟まずそのまま読めるようにする
    await selectReference(res.imported[0]!.reference_id);
    setStatus('1 件を取り込んだ');
    return;
  }

  if (res.imported.length > 0) {
    const ul = el('ul', { class: 'import-result' });
    for (const i of res.imported) {
      const li = el('li', {}, i.title);
      // 推測で埋めた項目はそう分かるようにする
      if (i.guessed) li.append(el('span', { class: 'chip' }, 'タイトルは推測'));
      if (!i.doi) li.append(el('span', { class: 'chip' }, 'DOI なし'));
      ul.append(li);
    }
    pane.append(el('div', { class: 'detail-section' }, el('h3', {}, '取り込んだ文献'), ul));
    pane.append(
      el(
        'p',
        { class: 'note-info' },
        'PDF は元の場所に置いたままです。コピーも移動もしていません。書誌が足りない場合は各文献の画面で直せます。',
      ),
    );
  }

  if (res.failed.length > 0) {
    const ul = el('ul', { class: 'import-result' });
    for (const f of res.failed) {
      ul.append(el('li', { class: 'failed' }, `${f.path}: ${f.error}`));
    }
    pane.append(el('div', { class: 'detail-section' }, el('h3', {}, '取り込めなかったファイル'), ul));
  }

  setStatus(
    res.failed.length > 0
      ? `取り込み ${res.imported.length} 件、失敗 ${res.failed.length} 件`
      : `${res.imported.length} 件を取り込んだ`,
    res.failed.length > 0 ? 'error' : 'info',
  );
});

// --- 調査報告 ----------------------------------------------------------------

function runStatusLabel(status: string): string {
  switch (status) {
    case 'ok':
      return '完了';
    case 'empty':
      return 'ヒットなし';
    case 'failed':
      return '失敗';
    case 'partial':
      return '一部失敗';
    default:
      return status;
  }
}

function formatReportWhen(runDate: string, createdAt: string): string {
  const clock = createdAt.replace('T', ' ').replace('Z', '').slice(0, 16);
  return clock || runDate;
}

function feedEmptyState(
  unscored: number,
  summary: string,
  scoreMode: 'mypaper' | 'blend',
  missingPdf: number,
  hasReports: boolean,
): HTMLElement {
  const goSettings = () => {
    const b = el('button', { class: 'btn', type: 'button' }, '設定を開く');
    b.setAttribute('data-variant', 'primary');
    b.addEventListener('click', () => openSettings());
    return b;
  };

  if (hasReports && unscored > 0) {
    const detail =
      scoreMode === 'mypaper' && missingPdf > 0
        ? `うち PDF が無いため未採点 ${missingPdf} 件。上の「読む順をつける」で取れる分だけ順位が付きます。`
        : scoreMode === 'blend'
          ? 'mypaper が空のため、課題意識・関連技術で採点します。「読む順をつける」を押してください。'
          : '上の「読む順をつける」を押すと、関連度順に並びます。';
    return el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-title' }, `未採点 ${unscored} 件`),
      el('p', { class: 'empty' }, detail),
    );
  }
  if (!signedIn) {
    return el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-title' }, 'まだログインしていません'),
      el(
        'p',
        { class: 'empty' },
        'メニューの設定（' +
          (window.api.platform === 'darwin' ? '⌘,' : 'Ctrl+,') +
          '）で Google ログインと課題意識を保存してください。',
      ),
      goSettings(),
    );
  }
  if (!summary) {
    return el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-title' }, '研究内容が未設定です'),
      el('p', { class: 'empty' }, '設定で研究内容の概要を書いて保存すると、調査を開始できます。'),
      goSettings(),
    );
  }
  return el(
    'div',
    { class: 'empty-state' },
    el('p', { class: 'empty-title' }, '報告はまだありません'),
    el(
      'p',
      { class: 'empty' },
      '上の「調査する」で収集を始めます。日次の調査も、終わった分は「取り込む」でここに入ります。',
    ),
  );
}

function unscoredCallout(
  unscored: number,
  scoreMode: 'mypaper' | 'blend',
  missingPdf: number,
): HTMLElement {
  if (scoreMode === 'mypaper' && missingPdf > 0) {
    return el(
      'p',
      { class: 'callout' },
      el('strong', {}, `PDF が無いため未採点 ${missingPdf} 件`),
      unscored > missingPdf
        ? `（他に未採点 ${unscored - missingPdf} 件）。「読む順をつける」で本文がある分だけ順位が付きます`
        : ' — 直リンクが無い・取得失敗。要旨で順位を捏造しません',
    );
  }
  if (scoreMode === 'blend') {
    return el(
      'p',
      { class: 'callout' },
      el('strong', {}, `未採点 ${unscored} 件`),
      ' — mypaper が空のため課題意識・関連技術で採点します。「読む順をつける」を押すまで順位は出ません',
    );
  }
  return el(
    'p',
    { class: 'callout' },
    el('strong', {}, `未採点 ${unscored} 件`),
    ' — 「読む順をつける」を押すまで順位は出ません',
  );
}

async function refreshFeed() {
  const res = (await guard('報告の取得', () => window.api.reports.list(projectId))) as
    | {
        reports: SurveyReport[];
        unscored: number;
        unscoredMissingPdf?: number;
        scoreMode?: 'mypaper' | 'blend';
        searchTerms?: string[];
      }
    | undefined;
  if (!res) return;

  const scoreMode = res.scoreMode ?? 'blend';
  const missingPdf = res.unscoredMissingPdf ?? 0;
  lastScoreMode = scoreMode;
  const hint = $('feed-score-hint');


  const list = $('feed-list');
  list.replaceChildren();

  if (res.reports.length === 0) {
    const summary = ($('summary') as HTMLTextAreaElement).value.trim();
    list.append(feedEmptyState(res.unscored, summary, scoreMode, missingPdf, false));
    selectedRunId = null;
    return;
  }

  if (res.unscored > 0) {
    list.append(unscoredCallout(res.unscored, scoreMode, missingPdf));
  }

  if (!selectedRunId || !res.reports.some((r) => r.run_id === selectedRunId)) {
    selectedRunId = res.reports[0]!.run_id;
  }

  for (const r of res.reports) {
    const row = el(
      'button',
      { class: 'row', 'aria-current': String(selectedRunId === r.run_id) },
      el('span', { class: 'row-title' }, `${r.run_date} の調査`),
      el(
        'span',
        { class: 'row-meta' },
        el('span', { class: 'chip', 'data-tone': r.status === 'ok' ? 'score' : r.status === 'failed' ? 'reading' : undefined }, runStatusLabel(r.status)),
        el('span', {}, `論文 ${r.paper_count} 件`),
        el('span', {}, r.trend ? 'トレンドあり' : r.paper_count > 0 ? 'トレンド未着' : ''),
      ),
    );
    row.addEventListener('click', () => {
      selectedRunId = r.run_id;
      selectedPaper = null;
      void refreshFeed();
    });
    list.append(row);
  }

  if (selectedRunId) await renderReportDetail(selectedRunId);
}

async function renderReportDetail(runId: string) {
  const got = (await guard('報告の詳細', () => window.api.reports.get(projectId, runId))) as
    | {
        report: SurveyReport;
        papers: RankedPaper[];
        searchTerms: string[];
        themes: string[];
      }
    | null
    | undefined;
  const pane = $('feed-detail');
  if (!got) {
    pane.replaceChildren(
      el(
        'div',
        { class: 'empty-state' },
        el('p', { class: 'empty-title' }, '報告を取れなかった'),
        el('p', { class: 'empty' }, '取り込みをやり直すか、調査するを押してください。'),
      ),
    );
    return;
  }

  const r = got.report;
  pane.replaceChildren();
  pane.append(el('h2', { class: 'detail-title' }, `${r.run_date} の調査`));
  pane.append(
    el(
      'p',
      { class: 'detail-meta' },
      [formatReportWhen(r.run_date, r.created_at), runStatusLabel(r.status), `論文 ${got.papers.length} 件`]
        .filter(Boolean)
        .join(' / '),
    ),
  );

  const keywords = keywordsStrip(got.searchTerms);
  if (keywords) pane.append(keywords);

  pane.append(
    el(
      'div',
      { class: 'detail-section' },
      el('h3', {}, '今のトレンド'),
      r.trend
        ? el('p', { class: 'abstract' }, r.trend)
        : el(
            'p',
            { class: 'note-info' },
            got.papers.length === 0
              ? 'この回では論文が無かったので、トレンドは出していません。'
              : 'トレンドはまだ無い。調査直後なら少し待って「取り込む」。欠けたままなら黙って埋めません。',
          ),
    ),
  );

  pane.append(
    el(
      'div',
      { class: 'detail-section' },
      el('h3', {}, '次にやる研究の候補'),
      got.themes.length > 0
        ? el(
            'ul',
            { class: 'theme-list' },
            ...got.themes.map((t) => el('li', {}, t)),
          )
        : el(
            'p',
            { class: 'note-info' },
            'この回の論文から次テーマを出せていません。論文が残っていれば「取り込む」で埋めます。',
          ),
    ),
  );

  pane.append(el('h3', { class: 'report-papers-head' }, `見つけた論文（${got.papers.length}）`));
  if (got.papers.length === 0) {
    pane.append(el('p', { class: 'note-info' }, 'この調査では新しい論文は残っていません。'));
    return;
  }

  got.papers.forEach((p, i) => {
    const row = el(
      'button',
      { class: 'row report-paper', 'aria-current': String(selectedPaper === p.paper_id) },
      el('span', { class: 'row-title' }, `${i + 1}. ${p.title}`),
      el(
        'span',
        { class: 'row-meta' },
        el('span', {}, [p.authors ?? '著者不明', yearFromPublishedAt(p.published_at) ?? '年不明'].join(' / ')),
        el('span', { class: 'chip', 'data-tone': 'score' }, `関連度 ${p.relevance?.toFixed(3) ?? '-'}`),
        el('span', { class: 'chip', 'data-tone': pdfTone(p) }, pdfLabel(p)),
      ),
    );
    row.addEventListener('click', () => {
      selectedPaper = p.paper_id;
      void renderReportDetail(runId);
    });
    pane.append(row);
  });

  const cur = got.papers.find((p) => p.paper_id === selectedPaper);
  if (cur) renderPaperDetailInto(pane, cur);
}

/** PDF の状態。空ファイルや購読ページを「あり」と言わない（C-07） */
function pdfLabel(p: RankedPaper): string {
  if (p.fulltext_path) return 'PDF 取得済み';
  if (p.pdf_url) return 'PDF あり';
  return 'PDF 未取得';
}

function pdfTone(p: RankedPaper): string | undefined {
  if (p.fulltext_path) return 'read';
  if (p.pdf_url) return 'reading';
  return undefined;
}

function renderPaperDetailInto(pane: HTMLElement, p: RankedPaper) {
  pane.append(el('h2', { class: 'detail-title' }, p.title));
  const year = yearFromPublishedAt(p.published_at);
  pane.append(
    el(
      'p',
      { class: 'detail-meta' },
      [p.authors, year ? String(year) : null].filter(Boolean).join(' / ') || '書誌情報なし',
    ),
  );

  pane.append(
    el(
      'div',
      { class: 'actions' },
      el('span', { class: 'chip', 'data-tone': 'score' }, `関連度（読む順） ${p.relevance?.toFixed(4) ?? '-'}`),
      el(
        'span',
        { class: 'chip' },
        lastScoreMode === 'mypaper'
          ? `原稿全体の平均 ${p.sim_summary?.toFixed(3) ?? '-'}`
          : `課題意識だけ ${p.sim_summary?.toFixed(3) ?? '-'}`,
      ),
      el('span', { class: 'chip', 'data-tone': pdfTone(p) }, pdfLabel(p)),
    ),
  );

  if (!p.pdf_url && !p.fulltext_path) {
    pane.append(
      el(
        'p',
        { class: 'note-info' },
        '公開の直 PDF がありません（購読のみ・HTML のみ）。有料 PDF は取りに行きません。手元にあればライブラリで添付できます。',
      ),
    );
  }

  pane.append(
    el(
      'p',
      { class: 'note-info' },
      lastScoreMode === 'mypaper'
        ? '関連度は原稿と PDF で一番近い箇所。原稿全体の平均は全段落を均したもので、順位には使いません。'
        : 'mypaper が空のため、タイトルと要旨を課題意識・関連技術と比べています。手元の論文ファイルは使っていません。関連度＝課題意識×0.7＋一番近い関連技術×0.3。',
    ),
  );

  pane.append(
    el(
      'p',
      { class: 'callout' },
      '順位だけを出しています。有効／除外の判定はしていません。',
      el('strong', {}, '上位には競合論文が混ざります。'),
    ),
  );

  if (p.nearest_chunk_text) {
    pane.append(
      el(
        'div',
        { class: 'detail-section' },
        el('h3', {}, `最も近い関連技術（${p.nearest_chunk_sim?.toFixed(3)}）`),
        el('p', { class: 'abstract' }, p.nearest_chunk_text),
        el('p', { class: 'note-info' }, 'これは最も近いという事実で、競合しているという判定ではありません。'),
      ),
    );
  }

  if (p.problem_excerpt) {
    pane.append(
      el(
        'div',
        { class: 'detail-section' },
        el('h3', {}, '課題'),
        el('p', { class: 'abstract' }, p.problem_excerpt),
      ),
    );
  }

  if (p.abstract) {
    pane.append(
      el('div', { class: 'detail-section' }, el('h3', {}, '要旨'), el('p', { class: 'abstract' }, p.abstract)),
    );
  }

  const add = el('button', { class: 'btn', 'data-variant': 'primary' }, 'ライブラリに保存');
  add.disabled = !!p.in_library;
  add.addEventListener('click', async () => {
    add.disabled = true;
    setStatus('ライブラリに保存し、PDF を取得しています…', 'busy');
    const res = await guard('ライブラリへの保存', () =>
      window.api.lib.add(projectId, {
        title: p.title,
        authors: p.authors,
        year: yearFromPublishedAt(p.published_at),
        abstract: p.abstract,
        url: p.url,
        venue: p.venue ?? null,
        item_type: p.item_type ?? undefined,
        doi: p.external_id && /^10\.\d{4,}/.test(p.external_id) ? p.external_id : null,
        paper_id: p.paper_id,
      }),
    );
    if (!res) {
      add.disabled = !!p.in_library;
      return;
    }
    setStatus(libraryAddStatus(res.pdf, res.citeConflict));
    await refreshFeed();
  });
  pane.append(el('div', { class: 'detail-section actions', 'data-align': 'end' }, add));
}

function libraryAddStatus(pdf: 'ok' | 'exists' | 'not_pdf' | 'failed' | 'skipped', citeConflict = false): string {
  const base = (() => {
    switch (pdf) {
      case 'ok':
        return 'ライブラリに保存し、PDF を取得した';
      case 'exists':
        return 'ライブラリに保存した（PDF は既にあった）';
      case 'not_pdf':
      case 'failed':
        return 'ライブラリに保存した。PDF は取得できなかった';
      case 'skipped':
        return 'ライブラリに保存した。公開の直 PDF は無かった';
    }
  })();
  return base + citeExportWarning(citeConflict);
}

/** マーカー内の手編集を検知して上書きしなかったときだけ警告を足す（ADR-0003 C-08） */
function citeExportWarning(citeConflict: boolean): string {
  return citeConflict ? '。引用ファイルは手編集を検知したため更新していない' : '';
}

/** 自発調査の結果表示。欠けたフィールドで落とさない（メインとレンダラの世代差） */
function keywordsStrip(terms: string[]): HTMLElement | null {
  const cleaned = terms.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return el(
    'p',
    { class: 'feed-keywords' },
    el('span', { class: 'feed-keywords-label' }, '検索キーワード'),
    ...cleaned.map((t) => el('span', { class: 'chip' }, t)),
  );
}

function collectOutcomeMessage(res: {
  inserted?: number;
  pulled?: number;
  statuses?: string[] | null;
  timedOut?: boolean;
  searchTerms?: string[] | null;
}): string {
  const inserted = res.inserted ?? 0;
  const pulled = res.pulled ?? 0;
  const statuses = Array.isArray(res.statuses) ? res.statuses : [];
  const terms = Array.isArray(res.searchTerms) ? res.searchTerms.filter((t) => t.trim()) : [];
  const kw = terms.length ? ` キーワード: ${terms.join(' · ')}` : '';
  if (res.timedOut && inserted === 0 && pulled === 0) {
    return '調査を投入した。まだ結果が無いので、しばらくして「取り込む」を押してください';
  }
  if (inserted > 0) return `上位 ${inserted} 件を取り込んだ。読む順を付けています…${kw}`;
  if (pulled > 0) return `クラウドでは ${pulled} 件あったが、既に手元にある候補だった${kw}`;
  if (statuses.includes('failed')) return '調査は失敗した。しばらくして「調査する」をやり直してください';
  if (statuses.includes('empty')) return `調査は終わったが、検索ヒットが 0 件だった${kw}`;
  return `調査が終わったが、新しい候補は無かった${kw}`;
}

$('feed-score').addEventListener('click', async () => {
  ($('feed-score') as HTMLButtonElement).disabled = true;
  ($('feed-cancel') as HTMLButtonElement).disabled = false;
  setStatus('読む順を付けています…', 'busy');
  await guard('読む順の付与', () => window.api.startScoring(projectId));
});

$('feed-collect').addEventListener('click', async () => {
  const btn = $('feed-collect') as HTMLButtonElement;
  btn.disabled = true;
  setStatus('調査を開始しています…', 'busy');
  try {
    const res = await window.api.startCollect(projectId);
    btn.disabled = false;
    if (res.run_id) selectedRunId = res.run_id;
    const text = collectOutcomeMessage(res);
    const inserted = res.inserted ?? 0;
    const statuses = Array.isArray(res.statuses) ? res.statuses : [];
    const tone = inserted > 0 ? 'busy' : statuses.includes('failed') ? 'error' : 'info';
    setStatus(text, tone);
    await refreshFeed();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setStatus('調査の開始に失敗: ' + message, 'error');
    const cooldown = /wait\s+(\d+)s/i.exec(message);
    const lockMs = cooldown ? Number(cooldown[1]) * 1000 : /短時間|rate.?limit/i.test(message) ? 60_000 : 0;
    if (lockMs > 0) {
      setTimeout(() => {
        btn.disabled = false;
      }, lockMs);
    } else {
      btn.disabled = false;
    }
  }
});

$('feed-sync').addEventListener('click', async () => {
  const btn = $('feed-sync') as HTMLButtonElement;
  btn.disabled = true;
  setStatus('クラウドから取り込んでいます…', 'busy');
  const res = await guard('取り込み', () => window.api.syncProject(projectId));
  btn.disabled = false;
  if (!res) return;
  setStatus(res.inserted > 0 ? `${res.inserted} 件を取り込んだ` : '新しい候補はありません');
  await refreshFeed();
  if (res.inserted > 0) {
    ($('feed-score') as HTMLButtonElement).disabled = true;
    ($('feed-cancel') as HTMLButtonElement).disabled = false;
    await guard('読む順の付与', () => window.api.startScoring(projectId));
  }
});

$('feed-cancel').addEventListener('click', () => {
  void window.api.cancelScoring();
  setStatus('中止を要求した。済んだ分は残ります。', 'busy');
});

window.api.onScoreEvent((raw) => {
  const e = raw as
    | { type: 'progress'; done: number; total: number }
    | { type: 'done'; scored: number }
    | { type: 'error'; message: string };

  if (e.type === 'progress') {
    setStatus(`読む順を付けています ${e.done} / ${e.total} 件`, 'busy');
    if (e.done % 5 === 0) void refreshFeed();
    return;
  }

  ($('feed-score') as HTMLButtonElement).disabled = false;
  ($('feed-cancel') as HTMLButtonElement).disabled = true;

  if (e.type === 'done') setStatus(`読む順を付けた: ${e.scored} 件`);
  else setStatus('読む順の付与に失敗: ' + e.message, 'error');

  void refreshFeed();
});

// --- My paper ----------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshMypaper() {
  if (!window.api.mypaper) return;
  const list = document.getElementById('mypaper-list');
  if (!list) return;
  const files = ((await guard('My paper の取得', () => window.api.mypaper.list(projectId))) ?? []) as MypaperFile[];
  list.replaceChildren();

  if (files.length === 0) {
    list.append(
      el(
        'div',
        { class: 'empty-state' },
        el('p', { class: 'empty-title' }, '文献がありません'),
        el('p', { class: 'empty' }, '「配置」から PDF / 原稿を保存してください。'),
      ),
    );
    selectedMypaper = null;
    showMypaperEmpty();
    return;
  }

  if (!selectedMypaper || !files.some((f) => f.path === selectedMypaper)) {
    selectedMypaper = files[0]!.path;
  }

  for (const f of files) {
    const row = el(
      'button',
      { class: 'row', 'aria-current': String(selectedMypaper === f.path) },
      el('span', { class: 'row-title' }, f.name),
      el(
        'span',
        { class: 'row-meta' },
        el('span', { class: 'chip' }, f.kind === 'pdf' ? 'PDF' : '原稿'),
        el('span', {}, formatBytes(f.bytes)),
      ),
    );
    row.addEventListener('click', () => {
      selectedMypaper = f.path;
      void refreshMypaper();
    });
    list.append(row);
  }

  const cur = files.find((f) => f.path === selectedMypaper);
  if (cur) renderMypaperDetail(cur);
}

function showMypaperEmpty(): void {
  const pane = $('mypaper-detail');
  pane.replaceChildren(
    el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-title' }, 'ファイルを置く'),
      el('p', { class: 'empty' }, ' PDF / 原稿を選択して閲覧・編集できます。'),
    ),
  );
}

function renderMypaperDetail(f: MypaperFile) {
  const pane = $('mypaper-detail');
  pane.replaceChildren();
  pane.append(el('h2', { class: 'detail-title' }, f.name));
  pane.append(
    el(
      'p',
      { class: 'detail-meta' },
      [f.kind === 'pdf' ? 'PDF' : '原稿', formatBytes(f.bytes), f.mtime.replace('T', ' ').slice(0, 16)].join(' / '),
    ),
  );
  pane.append(
    el(
      'p',
      { class: 'note-info' },
      f.kind === 'pdf'
        ? '置いた PDF から書誌を作り、ライブラリにも載せます。原本は mypaper に残します。'
        : '原稿は読む順の正本です。クラウドへは出しません。',
    ),
  );
  const open = el('button', { class: 'btn', 'data-variant': 'secondary' }, '外部で開く');
  open.addEventListener('click', async () => {
    const err = await window.api.lib.openExternally(f.path);
    if (err) setStatus('開けなかった: ' + err, 'error');
  });
  pane.append(el('div', { class: 'detail-section actions', 'data-align': 'start' }, open));
}

$('mypaper-import')?.addEventListener('click', async () => {
  const btn = $('mypaper-import') as HTMLButtonElement;
  btn.disabled = true;
  setStatus('自分の論文を配置しています…', 'busy');
  const res = await guard('My paper への配置', () => window.api.mypaper.import(projectId));
  btn.disabled = false;
  if (!res) return;
  const n = res.imported.length;
  const fail = res.failed.length;
  if (fail > 0) setStatus(`配置 ${n} 件、失敗 ${fail} 件`, 'error');
  else if (n === 0) setStatus('配置をキャンセルした');
  else setStatus(`${n} 件を mypaper に置いた。PDF は書誌を作っています`);
  await refreshMypaper();
});

$('mypaper-reveal')?.addEventListener('click', async () => {
  const res = await guard('Finder で表示', () => window.api.mypaper.reveal(projectId));
  if (res && 'ok' in res && !res.ok) setStatus(res.error, 'error');
});

try {
  window.api.mypaper.onChanged(() => {
    void refreshMypaper();
  });
} catch {
  // preload が古いと mypaper が無い。ウェルカムの作成は止めない
}

// --- プロジェクト -------------------------------------------------------------

function showWorkspace(root: string | null): void {
  projectRoot = root;
  const empty = $('proj-empty');
  const tree = $('proj-tree');
  const pathEl = $('proj-root');
  const settingsPath = $('settings-root-path');
  const titleEl = $('titlebar-title');
  const name = ($('proj-title') as HTMLInputElement).value.trim();
  const label = name || (root ? root.replace(/^.*[/\\]/, '') : 'AI-Research');
  titleEl.textContent = label;
  document.title = label;
  if (root) {
    empty.hidden = true;
    tree.hidden = false;
    pathEl.textContent = root;
    settingsPath.textContent = root;
  } else {
    empty.hidden = false;
    tree.hidden = true;
    pathEl.textContent = '';
    settingsPath.textContent = '';
  }
}

on('keyword-infer', 'click', () => {
  void inferKeywordsFromSummary(true);
});
on('keyword-add', 'keydown', (e) => {
  const ev = e as KeyboardEvent;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    addKeywordFromInput();
  }
});

$('proj-save').addEventListener('click', async () => {
  if (!projectId) {
    setStatus('先にプロジェクトを作ってください', 'error');
    return;
  }
  const title = ($('proj-title') as HTMLInputElement).value.trim();
  const summary = ($('summary') as HTMLTextAreaElement).value.trim();
  const claims = keywordTags;

  if (!summary) {
    setStatus('課題意識を書いてから保存してください', 'error');
    ($('summary') as HTMLTextAreaElement).focus();
    return;
  }
  if (!signedIn) {
    setStatus('先に Google でログインしてください', 'error');
    return;
  }

  const ok = await guard('保存', async () => {
    if (title) await window.api.updateTitle(projectId, title);
    await window.api.updateSummary(projectId, summary);
    await window.api.setClaims(projectId, claims);
    return true;
  });
  if (ok) {
    markSettingsCompleted(projectId);
    showWorkspace(projectRoot);
    setStatus('設定を保存した');
    closeSettings();
    void refreshFeed();
  }
});

function applyWorkspace(res: { root: string; title: string; action: 'create' | 'open' }): void {
  ($('proj-title') as HTMLInputElement).value = res.title;
  showWorkspace(res.root);
  setStatus(res.action === 'open' ? 'プロジェクトを開いた' : 'プロジェクトを作った');

  void (async () => {
    const projects = ((await window.api.listProjects()) ?? []) as ProjectRow[];
    const p =
      projects.find((x) => x.root_path === res.root) ??
      projects.find((x) => x.title === res.title) ??
      projects[0];
    if (!p) return;
    await enterApp(
      { ...p, title: res.title, root_path: res.root },
      { forceSettings: res.action === 'create' },
    );
  })();
}

$('proj-mkdir').addEventListener('click', async () => {
  const res = (await window.api.createWorkspace()) as
    | { ok: true; root: string; title: string; action: 'create' | 'open' }
    | { ok: false; canceled?: boolean; error?: string };
  if (!res.ok) {
    if (res.canceled) return;
    setStatus(res.error ?? 'プロジェクトを作れなかった', 'error');
    return;
  }
  applyWorkspace(res);
});

$('proj-open').addEventListener('click', async () => {
  const res = (await window.api.openWorkspace()) as
    | { ok: true; root: string; title: string; action: 'create' | 'open' }
    | { ok: false; canceled?: boolean; error?: string };
  if (!res.ok) {
    if (res.canceled) return;
    setStatus(res.error ?? 'プロジェクトを開けなかった', 'error');
    return;
  }
  applyWorkspace(res);
});

$('proj-reveal').addEventListener('click', async () => {
  const res = (await window.api.revealWorkspace(projectId)) as { ok: boolean; error?: string };
  if (!res.ok) setStatus(res.error ?? 'プロジェクトを開けなかった', 'error');
});

window.api.onWorkspaceChanged((e) => applyWorkspace(e));
window.api.onWorkspaceError((message) => setStatus(message, 'error'));
$('settings-form').addEventListener('submit', (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLElement | null;
  if (submitter?.id !== 'settings-close') {
    e.preventDefault();
    return;
  }
  // 未設定のまま閉じさせない
  if (needsSettings(currentSettingsSnapshot()) || !hasCompletedSettings(projectId)) {
    e.preventDefault();
    setStatus(
      !signedIn
        ? 'ログインと課題意識の保存が必要です'
        : '課題意識を書いて保存してください',
      'error',
    );
  }
});

settingsDialog().addEventListener('cancel', (e) => {
  if (needsSettings(currentSettingsSnapshot()) || !hasCompletedSettings(projectId)) {
    e.preventDefault();
    setStatus(
      !signedIn
        ? 'ログインと課題意識の保存が必要です'
        : '課題意識を書いて保存してください',
      'error',
    );
  }
});

window.api.onOpenSettings?.(() => openSettings());

function showAuth(next: boolean): void {
  signedIn = next;
  $('auth-chip').textContent = next ? 'クラウド: ログイン済み' : 'クラウド: 未ログイン';
  const label = $('auth-label');
  const login = $('auth-login') as HTMLButtonElement | null;
  const logout = $('auth-logout') as HTMLButtonElement | null;
  if (label) {
    label.textContent = next ? 'ログイン済み' : '未ログイン — 調査の取り込みに必要です';
  }
  if (login) login.hidden = next;
  if (logout) logout.hidden = !next;
}

$('auth-login').addEventListener('click', async () => {
  setStatus('ブラウザで Google にログインします…', 'busy');
  const res = await guard('ログイン', () => window.api.auth.login());
  if (res?.signedIn) {
    showAuth(true);
    setStatus(
      needsSettings(currentSettingsSnapshot(), true)
        ? 'ログインした。課題意識を書いて保存してください'
        : 'ログインした',
    );
  }
});

$('auth-logout').addEventListener('click', async () => {
  const res = await guard('ログアウト', () => window.api.auth.logout());
  showAuth(res?.signedIn ?? false);
  setStatus('ログアウトした');
});

window.api.auth.onChanged((e) => showAuth(e.signedIn));
window.api.auth.onError((message) => setStatus('ログインに失敗: ' + message, 'error'));
window.api.lib.onChanged(() => {
  void refreshLibrary();
});

// --- 起動 --------------------------------------------------------------------

type ProjectRow = {
  project_id: string;
  title: string;
  summary: string;
  root_path: string | null;
};

/** 自動生成の空スタブは「まだ作っていない」扱い */
function isUnsetProject(p: ProjectRow): boolean {
  const defaultName = !p.title.trim() || p.title === '新しいプロジェクト';
  return defaultName && !p.summary.trim() && !p.root_path;
}

function showWelcome(): void {
  $('welcome').hidden = false;
  $('shell').hidden = true;
  $('auth-chip').textContent = '';
  $('proj-root').textContent = '';
  $('titlebar-title').textContent = 'AI-Research';
  document.title = 'AI-Research';
  ($('welcome-title') as HTMLInputElement).focus();
}

async function enterApp(
  p: ProjectRow,
  opts: { forceSettings?: boolean } = {},
): Promise<void> {
  $('welcome').hidden = true;
  $('shell').hidden = false;

  projectId = p.project_id;
  ($('proj-title') as HTMLInputElement).value = p.title ?? '';
  ($('summary') as HTMLTextAreaElement).value = p.summary ?? '';
  showWorkspace(p.root_path ?? null);

  const claims = (await window.api.listClaims(projectId)) as { text: string }[];
  setKeywordTags(claims.map((c) => c.text));

  const auth = await window.api.auth.status();
  showAuth(auth.signedIn);

  showTab('feed');

  const mustSetup =
    opts.forceSettings ||
    !hasCompletedSettings(p.project_id) ||
    needsSettings(p, auth.signedIn);
  if (mustSetup) {
    setStatus(
      !auth.signedIn
        ? 'まず Google でログインし、課題意識を保存してください'
        : '課題意識を書いて保存してください',
    );
    openSettings();
  } else {
    setStatus('');
  }
}

async function boot() {
  document.body.dataset.platform = window.api.platform;
  const reveal = document.getElementById('proj-reveal');
  if (reveal) {
    reveal.textContent = window.api.platform === 'darwin' ? 'Finder で表示' : 'エクスプローラーで表示';
  }

  // ウェルカム中でもログイン状態は分かるようにする
  const auth = await window.api.auth.status();
  showAuth(auth.signedIn);

  const projects = ((await window.api.listProjects()) ?? []) as ProjectRow[];
  const ready = projects.find((p) => !isUnsetProject(p));
  if (!ready) {
    showWelcome();
    return;
  }
  await enterApp(ready);
}

void boot().catch((e) => setStatus('起動に失敗: ' + String(e), 'error'));
