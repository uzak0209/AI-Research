// UI。DADS の規定に沿って、一覧・詳細・絞り込みを 3 ペインに分ける。
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
  title: string;
  abstract: string | null;
  url: string | null;
  relevance: number | null;
  sim_summary: number | null;
  nearest_chunk_text: string | null;
  nearest_chunk_sim: number | null;
  in_library: number;
}

interface Attachment {
  attachment_id: string;
  path: string;
  kind: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
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
let libFilter: 'all' | 'starred' | ReadStatus = 'all';
let libTag: string | null = null;
let selectedRef: string | null = null;
let selectedPaper: string | null = null;
let viewer: PdfViewer | null = null;

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
  const s = $('status');
  s.textContent = text;
  s.setAttribute('data-tone', tone);
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

// --- タブ --------------------------------------------------------------------

for (const id of ['library', 'feed', 'project'] as const) {
  $(`tab-${id}`).addEventListener('click', () => {
    for (const other of ['library', 'feed', 'project'] as const) {
      const active = other === id;
      $(`tab-${other}`).setAttribute('aria-selected', String(active));
      $(`view-${other}`).setAttribute('data-active', String(active));
    }
    if (id === 'library') void refreshLibrary();
    if (id === 'feed') void refreshFeed();
  });
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
    list.append(
      el(
        'p',
        { class: 'empty' },
        counts && counts.total === 0
          ? '文献がまだありません。「＋ 文献を追加」から保存できます。'
          : '条件に合う文献がありません。',
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
  pane.replaceChildren(el('p', { class: 'empty' }, '左の一覧から文献を選んでください。'));
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
    pane.append(el('p', { class: 'empty' }, '左の一覧から文献を選んでください。'));
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

  // DOI があれば書誌を補える。外部へ出ることを明示する
  if (r.doi) {
    const lookup = el('button', { class: 'btn', 'data-variant': 'secondary' }, 'DOI から書誌を補う');
    lookup.addEventListener('click', async () => {
      if (
        !window.confirm(
          `DOI「${r.doi}」を OpenAlex に送って書誌を取得します。
何を読んでいるかが相手に伝わります。続けますか。`,
        )
      )
        return;
      const got = (await guard('書誌の取得', () => window.api.pdf.lookupDoi(r.doi!))) as
        | { title: string | null; authors: string | null; year: number | null; venue: string | null; abstract: string | null }
        | undefined;
      if (!got) return;
      await guard('書誌の反映', () =>
        window.api.lib.update(r.reference_id, {
          title: got.title ?? r.title,
          authors: got.authors ?? r.authors,
          year: got.year ?? r.year,
          venue: got.venue ?? r.venue,
          abstract: got.abstract ?? r.abstract,
        }),
      );
      setStatus('書誌を補った');
      await refreshLibrary();
      await renderRefDetail(r.reference_id);
    });
    pane.append(
      el(
        'div',
        { class: 'detail-section' },
        el('h3', {}, 'DOI'),
        el('p', { class: 'detail-meta' }, r.doi),
        el('div', { class: 'actions' }, lookup),
        el('p', { class: 'note-info' }, '押したときだけ外部 API に問い合わせます。既定では何も送りません。'),
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
  $('view-library').setAttribute('data-reading', 'false');
}

/**
 * 詳細ペインを PDF ビューアにする。
 * 文献を選んだときの既定の表示（書誌情報はボタンで開く）
 */
async function openInViewer(attachmentId: string, title: string): Promise<void> {
  closeViewer();
  // 読んでいる間は本文に幅を回す
  $('view-library').setAttribute('data-reading', 'true');

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
    const id = await guard('保存', () =>
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
    if (!id) return;
    selectedRef = id as string;
    setStatus('保存した');
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

// --- 新着候補 ----------------------------------------------------------------

async function refreshFeed() {
  const res = (await guard('候補の取得', () => window.api.ranked(projectId))) as
    | { ranked: RankedPaper[]; unscored: number }
    | undefined;
  if (!res) return;

  const list = $('feed-list');
  list.replaceChildren();

  if (res.unscored > 0) {
    // 実数で出す。残り時間の推定はしない（C-07）
    list.append(
      el(
        'p',
        { class: 'callout' },
        el('strong', {}, `未採点 ${res.unscored} 件`),
        '（採点するまで順位は出ません）',
      ),
    );
  }

  if (res.ranked.length === 0) {
    list.append(
      el(
        'p',
        { class: 'empty' },
        res.unscored > 0 ? '「採点する」を押すと順位が出ます。' : '候補がまだありません。',
      ),
    );
    return;
  }

  res.ranked.forEach((p, i) => {
    const row = el(
      'button',
      { class: 'row', 'aria-current': String(selectedPaper === p.paper_id) },
      el('span', { class: 'row-title' }, `${i + 1}. ${p.title}`),
      el(
        'span',
        { class: 'row-meta' },
        el('span', { class: 'chip', 'data-tone': 'score' }, `関連度 ${p.relevance?.toFixed(3) ?? '-'}`),
        ...(p.in_library ? [el('span', { class: 'chip' }, 'ライブラリ済')] : []),
      ),
    );
    row.addEventListener('click', () => {
      selectedPaper = p.paper_id;
      void refreshFeed();
      renderPaperDetail(p);
    });
    list.append(row);
  });

  const cur = res.ranked.find((p) => p.paper_id === selectedPaper);
  if (cur) renderPaperDetail(cur);
}

function renderPaperDetail(p: RankedPaper) {
  const pane = $('feed-detail');
  pane.replaceChildren();
  pane.append(el('h2', { class: 'detail-title' }, p.title));

  pane.append(
    el(
      'div',
      { class: 'actions' },
      el('span', { class: 'chip', 'data-tone': 'score' }, `関連度 ${p.relevance?.toFixed(4) ?? '-'}`),
      el('span', { class: 'chip' }, `概要との近さ ${p.sim_summary?.toFixed(3) ?? '-'}`),
    ),
  );

  // 断定しないことを画面に書く
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
        el('h3', {}, `最も近い提案手法（${p.nearest_chunk_sim?.toFixed(3)}）`),
        el('p', { class: 'abstract' }, p.nearest_chunk_text),
        el('p', { class: 'note-info' }, 'これは最も近いという事実で、競合しているという判定ではありません。'),
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
    const id = await guard('ライブラリへの保存', () =>
      window.api.lib.add(projectId, { title: p.title, abstract: p.abstract, url: p.url, paper_id: p.paper_id }),
    );
    if (!id) return;
    setStatus('ライブラリに保存した');
    await refreshFeed();
  });
  pane.append(el('div', { class: 'detail-section actions', 'data-align': 'end' }, add));
}

$('feed-score').addEventListener('click', async () => {
  ($('feed-score') as HTMLButtonElement).disabled = true;
  ($('feed-cancel') as HTMLButtonElement).disabled = false;
  setStatus('採点を開始した…', 'busy');
  await guard('採点の開始', () => window.api.startScoring(projectId));
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
    setStatus(`採点中 ${e.done} / ${e.total} 件`, 'busy');
    if (e.done % 5 === 0) void refreshFeed();
    return;
  }

  ($('feed-score') as HTMLButtonElement).disabled = false;
  ($('feed-cancel') as HTMLButtonElement).disabled = true;

  if (e.type === 'done') setStatus(`採点した: ${e.scored} 件`);
  else setStatus('採点に失敗: ' + e.message, 'error');

  void refreshFeed();
});

// --- プロジェクト -------------------------------------------------------------

function showWorkspace(root: string | null): void {
  projectRoot = root;
  const empty = $('proj-empty');
  const tree = $('proj-tree');
  const pathEl = $('proj-root');
  const titleEl = $('titlebar-title');
  const name = ($('proj-title') as HTMLInputElement).value.trim();
  const label = name || (root ? root.replace(/^.*[/\\]/, '') : 'AI-Research');
  titleEl.textContent = label;
  document.title = label;
  if (root) {
    empty.hidden = true;
    tree.hidden = false;
    pathEl.textContent = root;
  } else {
    empty.hidden = false;
    tree.hidden = true;
    pathEl.textContent = '';
  }
}

$('proj-save').addEventListener('click', async () => {
  const title = ($('proj-title') as HTMLInputElement).value.trim();
  const summary = ($('summary') as HTMLTextAreaElement).value.trim();
  const claims = ($('claims') as HTMLTextAreaElement).value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const ok = await guard('保存', async () => {
    if (title) await window.api.updateTitle(projectId, title);
    await window.api.updateSummary(projectId, summary);
    await window.api.setClaims(projectId, claims);
    return true;
  });
  if (ok) setStatus('保存した。採点し直しが必要です。');
});

function applyWorkspace(res: { root: string; title: string; action: 'create' | 'open' }): void {
  ($('proj-title') as HTMLInputElement).value = res.title;
  showWorkspace(res.root);
  setStatus(res.action === 'open' ? '作業フォルダを開いた' : '作業フォルダを作った');
  $('tab-project').click();
}

$('proj-mkdir').addEventListener('click', async () => {
  const res = (await window.api.createWorkspace()) as
    | { ok: true; root: string; title: string; action: 'create' | 'open' }
    | { ok: false; canceled?: boolean; error?: string };
  if (!res.ok) {
    if (res.canceled) return;
    setStatus(res.error ?? 'フォルダを作れなかった', 'error');
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
    setStatus(res.error ?? 'フォルダを開けなかった', 'error');
    return;
  }
  applyWorkspace(res);
});

$('proj-reveal').addEventListener('click', async () => {
  const res = (await window.api.revealWorkspace(projectId)) as { ok: boolean; error?: string };
  if (!res.ok) setStatus(res.error ?? 'フォルダを開けなかった', 'error');
});

window.api.onWorkspaceChanged((e) => applyWorkspace(e));
window.api.onWorkspaceError((message) => setStatus(message, 'error'));

// --- 起動 --------------------------------------------------------------------

async function boot() {
  document.body.dataset.platform = window.api.platform;
  $('proj-reveal').textContent = window.api.platform === 'darwin' ? 'Finder で表示' : 'エクスプローラーで表示';
  const projects = (await window.api.listProjects()) as {
    project_id: string;
    title: string;
    summary: string;
    root_path: string | null;
  }[];
  const p =
    projects[0] ??
    ((await window.api.createProject('新しいプロジェクト', '')) as {
      project_id: string;
      title: string;
      summary: string;
      root_path: string | null;
    });

  projectId = p.project_id;
  ($('proj-title') as HTMLInputElement).value = p.title ?? '';
  ($('summary') as HTMLTextAreaElement).value = p.summary ?? '';
  showWorkspace(p.root_path ?? null);

  const claims = (await window.api.listClaims(projectId)) as { text: string }[];
  ($('claims') as HTMLTextAreaElement).value = claims.map((c) => c.text).join('\n');

  await refreshLibrary();
}

void boot().catch((e) => setStatus('起動に失敗: ' + String(e), 'error'));
