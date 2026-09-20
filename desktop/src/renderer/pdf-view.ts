// アプリ内 PDF ビューア（FR-14）。
//
// ADR-0003 の「外部アプリの起動を必要としない」を満たすため pdf.js で自前に描く。
//
// できること:
//   選択モード … 文字を選ぶと小窓が出る。色を押せばハイライト、コメントを押せば余白に付箋
//   ペンモード … 自由に線を引く
//
// コメントは Word や Google ドキュメントと同じで、**選択した箇所の高さに合わせて右の余白に並ぶ**。
// 付箋と本文のハイライトはクリックで行き来できる。
//
// **PDF 本体には一切書き戻さない**（C-08）。座標はページ幅・高さに対する比で持つので、
// 拡大率を変えても位置がずれない。

import * as pdfjs from 'pdfjs-dist';
// vite がワーカーを別ファイルとして出す
import PdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?worker';
import { toPathData, type NormPoint } from './ink-path.js';
import { mergeRects, type NormRect } from './rects.js';

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();

export type AnnotationKind = 'highlight' | 'ink';

export interface Annotation {
  annotation_id: string;
  page: number;
  kind: AnnotationKind;
  rect_json: string | null;
  path_json: string | null;
  stroke_width: number | null;
  quote: string | null;
  color: string | null;
  comment: string | null;
}

export interface PdfViewerHost {
  readAttachment(attachmentId: string): Promise<{ path: string; data: Uint8Array }>;
  listAnnotations(attachmentId: string): Promise<Annotation[]>;
  addHighlight(
    attachmentId: string,
    a: { page: number; rects: NormRect[]; quote: string; color: string; comment?: string | null },
  ): Promise<string>;
  addInk(
    attachmentId: string,
    a: { page: number; points: NormPoint[]; color: string; strokeWidth: number },
  ): Promise<string>;
  setComment(annotationId: string, comment: string): Promise<void>;
  removeAnnotation(annotationId: string): Promise<void>;
  onError(message: string): void;
  onChange?(): void;
}

const COLORS = [
  { name: '黄', value: '#f5c518' },
  { name: '緑', value: '#3f9e6e' },
  { name: '赤', value: '#c8382f' },
  { name: '青', value: '#1a5490' },
];

/** 線の太さ。ページ幅に対する比で持つ */
const PEN_WIDTHS = [
  { name: '細', value: 0.0025 },
  { name: '中', value: 0.005 },
  { name: '太', value: 0.01 },
];

type Tool = 'select' | 'pen';

/** 付箋どうしの最小の間隔 */
const CARD_GAP = 8;

export class PdfViewer {
  private container: HTMLElement;
  private host: PdfViewerHost;
  private doc: pdfjs.PDFDocumentProxy | null = null;
  private task: pdfjs.PDFDocumentLoadingTask | null = null;
  private attachmentId = '';
  private annotations: Annotation[] = [];
  /** null = 幅に合わせる。数値 = 利用者が決めた倍率 */
  private scale: number | null = null;
  /** 1 ページ目の素の幅。幅合わせの計算に使う */
  private baseWidth = 612;
  private color = COLORS[0]!.value;
  private penWidth = PEN_WIDTHS[1]!.value;
  private tool: Tool = 'select';
  private bodyEl!: HTMLElement;
  private pagesBox!: HTMLElement;
  private marginBox!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private popup: HTMLElement | null = null;

  constructor(container: HTMLElement, host: PdfViewerHost) {
    this.container = container;
    this.host = host;
  }

  async open(attachmentId: string): Promise<void> {
    this.attachmentId = attachmentId;
    this.container.replaceChildren();

    const loading = document.createElement('p');
    loading.className = 'empty';
    loading.textContent = 'PDF を読み込んでいます…';
    this.container.append(loading);

    let file: { path: string; data: Uint8Array };
    try {
      file = await this.host.readAttachment(attachmentId);
    } catch (e) {
      // ファイルが移動・削除されている場合。空の表示にして成功に見せない（C-07）
      loading.textContent = 'PDF を開けませんでした: ' + msg(e);
      return;
    }

    try {
      // pdf.js は渡したバッファを破棄するので複製してから渡す
      this.task = pdfjs.getDocument({ data: file.data.slice(), useSystemFonts: true });
      this.doc = await this.task.promise;
      this.baseWidth = (await this.doc.getPage(1)).getViewport({ scale: 1 }).width;
    } catch (e) {
      loading.textContent = 'PDF を解釈できませんでした: ' + msg(e);
      return;
    }

    this.annotations = await this.host.listAnnotations(attachmentId).catch(() => []);
    this.container.replaceChildren();
    this.renderChrome(file.path);
    await this.renderPages();
  }

  close(): void {
    this.closePopup();
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
    this.container.replaceChildren();
  }

  /** 画面から外された後に描き続けない（閉じた直後の非同期処理が走るため） */
  private get alive(): boolean {
    return this.doc !== null && this.container.isConnected;
  }

  // --- 倍率 ----------------------------------------------------------------------

  /**
   * 実際に使う倍率。**既定は表示できる幅に合わせる。**
   * 固定倍率にすると、狭いペインではページが溢れて左側が画面外に出て読めなくなる
   */
  private effectiveScale(): number {
    if (this.scale !== null) return this.scale;
    const avail = this.pagesBox?.clientWidth || this.container.clientWidth;
    if (!avail) return 1;
    return Math.min(2, Math.max(0.3, (avail - 24) / this.baseWidth));
  }

  private async setScale(next: number | null): Promise<void> {
    this.scale = next === null ? null : Math.min(3, Math.max(0.3, Number(next.toFixed(2))));
    await this.renderPages();
  }

  // --- 画面の枠 -------------------------------------------------------------------

  private renderChrome(path: string): void {
    const bar = document.createElement('div');
    bar.className = 'pdf-toolbar';

    const tools = document.createElement('div');
    tools.className = 'pdf-tools';
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', '書き込みの道具');
    for (const [t, label, hint] of [
      ['select', '選択', '文字を選ぶとハイライトとコメント'],
      ['pen', 'ペン', '自由に線を引く'],
    ] as [Tool, string, string][]) {
      const b = document.createElement('button');
      b.className = 'pdf-tool';
      b.textContent = label;
      b.title = hint;
      b.setAttribute('aria-pressed', String(this.tool === t));
      b.addEventListener('click', () => {
        this.tool = t;
        this.closePopup();
        for (const o of tools.querySelectorAll('.pdf-tool')) {
          o.setAttribute('aria-pressed', String(o === b));
        }
        this.bodyEl.setAttribute('data-tool', this.tool);
      });
      tools.append(b);
    }

    const info = document.createElement('span');
    info.className = 'pdf-info';
    info.textContent = `${this.doc!.numPages} ページ`;
    info.title = path;

    this.zoomLabel = document.createElement('span');
    this.zoomLabel.className = 'pdf-info pdf-zoom';

    const zoomOut = iconButton('－', '縮小', () => void this.setScale(this.effectiveScale() - 0.2));
    const zoomIn = iconButton('＋', '拡大', () => void this.setScale(this.effectiveScale() + 0.2));

    const fit = document.createElement('button');
    fit.className = 'pdf-tool';
    fit.textContent = '幅に合わせる';
    fit.title = 'ページの幅を表示領域に合わせる';
    fit.addEventListener('click', () => void this.setScale(null));

    const colorBox = document.createElement('div');
    colorBox.className = 'pdf-colors';
    colorBox.append(labelSpan('色'));
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'pdf-color';
      b.style.background = c.value;
      b.title = c.name;
      b.setAttribute('aria-label', `色: ${c.name}`);
      b.setAttribute('aria-pressed', String(this.color === c.value));
      b.addEventListener('click', () => {
        this.color = c.value;
        for (const o of colorBox.querySelectorAll('.pdf-color')) {
          o.setAttribute('aria-pressed', String(o === b));
        }
      });
      colorBox.append(b);
    }

    const widthBox = document.createElement('div');
    widthBox.className = 'pdf-colors';
    widthBox.append(labelSpan('太さ'));
    for (const w of PEN_WIDTHS) {
      const b = document.createElement('button');
      b.className = 'pdf-tool';
      b.textContent = w.name;
      b.title = `線の太さ: ${w.name}`;
      b.setAttribute('aria-pressed', String(this.penWidth === w.value));
      b.addEventListener('click', () => {
        this.penWidth = w.value;
        for (const o of widthBox.querySelectorAll('.pdf-tool')) {
          o.setAttribute('aria-pressed', String(o === b));
        }
      });
      widthBox.append(b);
    }

    bar.append(tools, info, zoomOut, this.zoomLabel, zoomIn, fit, colorBox, widthBox);
    this.container.append(bar);

    const hint = document.createElement('p');
    hint.className = 'note-info pdf-hint';
    hint.textContent = '書き込みはこのアプリの中だけに保存されます。PDF ファイル自体は変わりません。';
    this.container.append(hint);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'pdf-body';
    this.bodyEl.setAttribute('data-tool', this.tool);

    this.pagesBox = document.createElement('div');
    this.pagesBox.className = 'pdf-pages';

    // Word / Google ドキュメントと同じく、本文の右の余白に付箋を並べる
    this.marginBox = document.createElement('div');
    this.marginBox.className = 'pdf-margin';
    this.marginBox.setAttribute('aria-label', 'コメント');

    this.bodyEl.append(this.pagesBox, this.marginBox);
    this.container.append(this.bodyEl);

    // 何もない所を押したら小窓を閉じる
    this.bodyEl.addEventListener('pointerdown', (ev) => {
      if (!(ev.target instanceof Element)) return;
      if (ev.target.closest('.pdf-popup, .pdf-anno, .pdf-ink-path, .pdf-card')) return;
      this.closePopup();
    });
  }

  // --- ページ描画 ------------------------------------------------------------------

  private async renderPages(): Promise<void> {
    if (!this.alive) return;
    this.closePopup();
    this.pagesBox.replaceChildren();

    const scale = this.effectiveScale();
    this.zoomLabel.textContent = `${Math.round(scale * 100)} %`;

    for (let n = 1; n <= this.doc!.numPages; n++) {
      // ページ描画は非同期なので、途中で閉じられることがある
      if (!this.alive) return;

      const page = await this.doc!.getPage(n);
      const viewport = page.getViewport({ scale });

      const wrap = document.createElement('div');
      wrap.className = 'pdf-page';
      wrap.id = `pdf-page-${n}`;
      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      wrap.append(canvas);

      const textLayer = document.createElement('div');
      textLayer.className = 'pdf-text-layer';
      wrap.append(textLayer);

      const annoLayer = document.createElement('div');
      annoLayer.className = 'pdf-anno-layer';
      wrap.append(annoLayer);

      const ink = document.createElement('canvas');
      ink.className = 'pdf-ink-layer';
      ink.width = Math.floor(viewport.width);
      ink.height = Math.floor(viewport.height);
      wrap.append(ink);

      this.pagesBox.append(wrap);

      const ctx = canvas.getContext('2d');
      if (ctx) await page.render({ canvas, canvasContext: ctx, viewport }).promise;

      const tc = await page.getTextContent();
      await new pdfjs.TextLayer({ textContentSource: tc, container: textLayer, viewport }).render();

      this.paintPage(annoLayer, n, viewport.width, viewport.height);

      wrap.addEventListener('mouseup', () => {
        if (this.tool !== 'select') return;
        this.onTextSelection(n, wrap);
      });

      this.wirePen(ink, n, viewport.width, viewport.height);
    }

    this.renderMargin();
  }

  private paintPage(layer: HTMLElement, page: number, w: number, h: number): void {
    layer.replaceChildren();

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pdf-ink-svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    layer.append(svg);

    for (const a of this.annotations.filter((x) => x.page === page)) {
      if (a.kind === 'highlight') this.paintHighlight(layer, a, w, h);
      else this.paintInk(svg, a, w, h);
    }
  }

  private paintHighlight(layer: HTMLElement, a: Annotation, w: number, h: number): void {
    // 以前に保存した重なりのある矩形も、描くときにまとめて濃さを均一にする
    for (const r of mergeRects(parseRects(a))) {
      const box = document.createElement('div');
      box.className = 'pdf-anno';
      box.style.left = `${r.x * w}px`;
      box.style.top = `${r.y * h}px`;
      box.style.width = `${r.w * w}px`;
      box.style.height = `${r.h * h}px`;
      box.style.background = a.color ?? '#f5c518';
      box.dataset.anno = a.annotation_id;
      if (a.comment !== null) box.classList.add('has-comment');
      box.title = a.comment ? `コメント: ${a.comment}` : (a.quote ?? '');
      box.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.onAnnotationClick(a, box);
      });
      layer.append(box);
    }
  }

  private paintInk(svg: SVGElement, a: Annotation, w: number, h: number): void {
    const pts = parsePoints(a);
    if (pts.length < 2) return;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', toPathData(pts, w, h));
    path.setAttribute('stroke', a.color ?? '#c8382f');
    path.setAttribute('stroke-width', String((a.stroke_width ?? 0.005) * w));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('class', 'pdf-ink-path' + (a.comment !== null ? ' has-comment' : ''));
    path.dataset.anno = a.annotation_id;
    path.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onAnnotationClick(a, path);
    });
    svg.append(path);
  }

  private refreshPage(page: number): void {
    const wrap = document.getElementById(`pdf-page-${page}`);
    const layer = wrap?.querySelector<HTMLElement>('.pdf-anno-layer');
    if (wrap && layer) this.paintPage(layer, page, wrap.clientWidth, wrap.clientHeight);
  }

  // --- 文字を選んだとき（小窓） ---------------------------------------------------------

  private onTextSelection(page: number, wrap: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const quote = sel.toString().trim();
    if (!quote) return;

    const range = sel.getRangeAt(0);
    if (!wrap.contains(range.commonAncestorContainer)) return;

    const base = wrap.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects());
    const rects: NormRect[] = [];
    for (const r of clientRects) {
      if (r.width < 1 || r.height < 1) continue;
      rects.push({
        x: (r.left - base.left) / base.width,
        y: (r.top - base.top) / base.height,
        w: r.width / base.width,
        h: r.height / base.height,
      });
    }
    // 文字の断片ごとの矩形をそのまま塗ると、重なった所だけ濃くなって縞になる。
    // 行ごとにひとつながりへまとめてから保存する
    const merged = mergeRects(rects);
    if (merged.length === 0) return;

    const near = clientRects.at(-1) ?? base;
    this.openSelectionPopup(page, merged, quote, near);
    sel.removeAllRanges();
  }

  /** 選択直後に出す小窓。色を押せばハイライトだけ、コメントを押せば付箋も作る */
  private openSelectionPopup(page: number, rects: NormRect[], quote: string, near: DOMRect): void {
    const pop = this.makePopup(near);
    pop.append(labelSpan('ハイライト'));

    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'pdf-color';
      b.style.background = c.value;
      b.title = c.name;
      b.setAttribute('aria-label', `${c.name}でハイライト`);
      b.addEventListener('click', () => {
        this.closePopup();
        void this.saveHighlight(page, rects, quote, c.value, null);
      });
      pop.append(b);
    }

    const withComment = document.createElement('button');
    withComment.className = 'pdf-tool';
    withComment.textContent = 'コメントを追加';
    withComment.addEventListener('click', () => {
      this.closePopup();
      void this.saveHighlight(page, rects, quote, this.color, '');
    });
    pop.append(withComment);
  }

  /** 既にある書き込みを押したとき */
  private onAnnotationClick(a: Annotation, anchor: Element): void {
    // コメントが付いていれば付箋へ移る
    if (a.comment !== null) {
      this.focusCard(a.annotation_id);
      return;
    }

    const pop = this.makePopup(anchor.getBoundingClientRect());

    const add = document.createElement('button');
    add.className = 'pdf-tool';
    add.textContent = 'コメントを追加';
    add.addEventListener('click', async () => {
      this.closePopup();
      try {
        await this.host.setComment(a.annotation_id, '');
      } catch (e) {
        this.host.onError('コメントを作れなかった: ' + msg(e));
        return;
      }
      a.comment = '';
      this.refreshPage(a.page);
      this.renderMargin();
      this.focusCard(a.annotation_id);
    });

    const del = document.createElement('button');
    del.className = 'pdf-tool';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      this.closePopup();
      void this.deleteAnnotation(a);
    });

    pop.append(add, del);
  }

  private makePopup(near: DOMRect): HTMLElement {
    this.closePopup();

    const pop = document.createElement('div');
    pop.className = 'pdf-popup';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '書き込みの操作');

    const base = this.bodyEl.getBoundingClientRect();
    pop.style.left = `${Math.max(4, near.left - base.left + this.bodyEl.scrollLeft)}px`;
    pop.style.top = `${near.bottom - base.top + this.bodyEl.scrollTop + 6}px`;

    this.bodyEl.append(pop);
    this.popup = pop;
    return pop;
  }

  private closePopup(): void {
    this.popup?.remove();
    this.popup = null;
  }

  // --- 保存 ------------------------------------------------------------------------

  private async saveHighlight(
    page: number,
    rects: NormRect[],
    quote: string,
    color: string,
    comment: string | null,
  ): Promise<void> {
    try {
      const id = await this.host.addHighlight(this.attachmentId, {
        page,
        rects,
        quote,
        color,
        comment,
      });
      this.annotations.push({
        annotation_id: id,
        page,
        kind: 'highlight',
        rect_json: JSON.stringify(rects),
        path_json: null,
        stroke_width: null,
        quote,
        color,
        comment,
      });
      if (!this.alive) return;
      this.refreshPage(page);
      this.renderMargin();
      this.host.onChange?.();
      if (comment !== null) this.focusCard(id);
    } catch (e) {
      this.host.onError('ハイライトを保存できなかった: ' + msg(e));
    }
  }

  private async deleteAnnotation(a: Annotation): Promise<void> {
    if (!window.confirm('この書き込みを消します。コメントも一緒に消えます。')) return;
    try {
      await this.host.removeAnnotation(a.annotation_id);
      this.annotations = this.annotations.filter((x) => x.annotation_id !== a.annotation_id);
      if (!this.alive) return;
      this.refreshPage(a.page);
      this.renderMargin();
      this.host.onChange?.();
    } catch (e) {
      this.host.onError('削除できなかった: ' + msg(e));
    }
  }

  // --- ペン -------------------------------------------------------------------------

  private wirePen(canvas: HTMLCanvasElement, page: number, w: number, h: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let drawing = false;
    let points: NormPoint[] = [];

    const pos = (ev: PointerEvent): NormPoint => {
      const r = canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (points.length < 2) return;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.penWidth * w;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(points[0]!.x * w, points[0]!.y * h);
      for (const p of points.slice(1)) ctx.lineTo(p.x * w, p.y * h);
      ctx.stroke();
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (this.tool !== 'pen') return;
      drawing = true;
      points = [pos(ev)];
      canvas.setPointerCapture(ev.pointerId);
    });

    canvas.addEventListener('pointermove', (ev) => {
      if (!drawing) return;
      points.push(pos(ev));
      draw();
    });

    const finish = async () => {
      if (!drawing) return;
      drawing = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 点が足りない線は保存しない（押し間違い）
      if (points.length < 2) {
        points = [];
        return;
      }

      const saved = points;
      points = [];
      try {
        const id = await this.host.addInk(this.attachmentId, {
          page,
          points: saved,
          color: this.color,
          strokeWidth: this.penWidth,
        });
        this.annotations.push({
          annotation_id: id,
          page,
          kind: 'ink',
          rect_json: null,
          path_json: JSON.stringify(saved),
          stroke_width: this.penWidth,
          quote: null,
          color: this.color,
          comment: null,
        });
        if (!this.alive) return;
        this.refreshPage(page);
        this.renderMargin();
        this.host.onChange?.();
      } catch (e) {
        this.host.onError('書き込みを保存できなかった: ' + msg(e));
      }
    };

    canvas.addEventListener('pointerup', () => void finish());
    canvas.addEventListener('pointercancel', () => void finish());
    canvas.addEventListener('pointerleave', () => void finish());
  }

  // --- 右の余白（付箋） ---------------------------------------------------------------

  /** コメントが付いた書き込みだけを、元の位置の高さに合わせて並べる */
  private renderMargin(): void {
    this.marginBox.replaceChildren();

    const withComment = this.annotations
      .filter((a) => a.comment !== null)
      .sort((x, y) => x.page - y.page || this.anchorTop(x) - this.anchorTop(y));

    if (withComment.length === 0) {
      const p = document.createElement('p');
      p.className = 'note-info pdf-margin-empty';
      p.textContent = '文字を選んで「コメントを追加」を押すと、ここに並びます。';
      this.marginBox.append(p);
      return;
    }

    let prevBottom = 0;
    for (const a of withComment) {
      const card = this.commentCard(a);
      this.marginBox.append(card);

      // 元の位置の高さに合わせる。重なるときは下へずらす
      const wanted = this.anchorTop(a);
      const top = Math.max(wanted, prevBottom + CARD_GAP);
      card.style.top = `${top}px`;
      prevBottom = top + card.offsetHeight;
    }
  }

  /** その書き込みが本文のどの高さにあるか（ページ束の中の px） */
  private anchorTop(a: Annotation): number {
    const wrap = document.getElementById(`pdf-page-${a.page}`);
    if (!wrap) return 0;

    let ratio = 0;
    if (a.kind === 'highlight') {
      const rects = parseRects(a);
      if (rects.length > 0) ratio = Math.min(...rects.map((r) => r.y));
    } else {
      const pts = parsePoints(a);
      if (pts.length > 0) ratio = Math.min(...pts.map((p) => p.y));
    }
    return wrap.offsetTop + ratio * wrap.clientHeight;
  }

  private commentCard(a: Annotation): HTMLElement {
    const card = document.createElement('article');
    card.className = 'pdf-card';
    card.id = `anno-${a.annotation_id}`;

    const head = document.createElement('div');
    head.className = 'pdf-card-head';

    const swatch = document.createElement('span');
    swatch.className = 'pdf-note-swatch';
    swatch.style.background = a.color ?? '#f5c518';
    swatch.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'pdf-info';
    label.textContent = `${a.page} ページ`;

    const jump = document.createElement('button');
    jump.className = 'pdf-card-btn';
    jump.textContent = '本文へ';
    jump.addEventListener('click', () => this.focusAnnotationInPage(a));

    const del = document.createElement('button');
    del.className = 'pdf-card-btn';
    del.textContent = '削除';
    del.addEventListener('click', () => void this.deleteAnnotation(a));

    head.append(swatch, label, jump, del);
    card.append(head);

    if (a.quote) {
      const q = document.createElement('blockquote');
      q.className = 'pdf-card-quote';
      q.textContent = a.quote;
      card.append(q);
    }

    const ta = document.createElement('textarea');
    ta.rows = 3;
    ta.placeholder = 'コメントを書く';
    ta.value = a.comment ?? '';
    ta.setAttribute('aria-label', `${a.page} ページの書き込みへのコメント`);

    const state = document.createElement('p');
    state.className = 'note-info';

    let timer: number | undefined;
    ta.addEventListener('input', () => {
      window.clearTimeout(timer);
      state.textContent = '入力中…';
      timer = window.setTimeout(async () => {
        try {
          await this.host.setComment(a.annotation_id, ta.value);
          a.comment = ta.value;
          state.textContent = '保存した ' + new Date().toLocaleTimeString('ja-JP');
          this.refreshPage(a.page);
          this.host.onChange?.();
        } catch (e) {
          // 保存できていないのに「保存した」と出さない（C-07）
          state.textContent = '保存できなかった: ' + msg(e);
        }
      }, 600);
    });

    // 高さが変われば重なりが変わるので並べ直す
    ta.addEventListener('blur', () => this.renderMargin());

    card.append(ta, state);
    return card;
  }

  private focusCard(id: string): void {
    const card = document.getElementById(`anno-${id}`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('is-focused');
    window.setTimeout(() => card.classList.remove('is-focused'), 1200);
    card.querySelector('textarea')?.focus();
  }

  private focusAnnotationInPage(a: Annotation): void {
    const target = this.pagesBox.querySelector<HTMLElement>(`[data-anno="${a.annotation_id}"]`);
    (target ?? document.getElementById(`pdf-page-${a.page}`))?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
    target?.classList.add('is-flash');
    window.setTimeout(() => target?.classList.remove('is-flash'), 1200);
  }
}

// --- 小物 --------------------------------------------------------------------------

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseRects(a: Annotation): NormRect[] {
  try {
    return JSON.parse(a.rect_json ?? '[]') as NormRect[];
  } catch {
    return []; // 壊れた座標は描かない
  }
}

function parsePoints(a: Annotation): NormPoint[] {
  try {
    return JSON.parse(a.path_json ?? '[]') as NormPoint[];
  } catch {
    return [];
  }
}

function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'icon-btn';
  b.textContent = text;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function labelSpan(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'pdf-info';
  s.textContent = text;
  return s;
}
