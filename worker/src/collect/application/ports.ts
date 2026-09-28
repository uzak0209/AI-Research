import type { CollectMessage } from '../../env';
import type { OrcaChatOk } from '../../shared/orca/chat';
import type { FetchedPaper } from '../../shared/papers/domain';
import type { ScoredPaper } from '../domain';
import type { SearchTerms } from './search-terms';

export type ListedProject = {
  project_id: string;
  summary: string;
  user_id: string;
  search_terms: string[];
};

export type ProjectList = {
  list(): Promise<ListedProject[]>;
};

export type CollectIdempotency = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
};

export type CollectQueue = {
  sendBatch(messages: { body: CollectMessage }[]): Promise<void>;
};

export type CollectClock = {
  today(): string;
};

export type ScheduleDeps = {
  clock: CollectClock;
  idempotency: CollectIdempotency;
  projects: ProjectList;
  queue: CollectQueue;
};

export type FetchPapersOpts = {
  /** このプロジェクトで既に run_papers にある ID。同じ先頭ページを新規扱いしない */
  skipIds?: ReadonlySet<string>;
  take?: number;
  maxPages?: number;
};

export type PaperFetcher = {
  fetch(source: string, query: string, opts?: FetchPapersOpts): Promise<FetchedPaper[]>;
};

export type CollectReport = {
  trend: string | null;
  themes: string[];
};

export type RunStore = {
  save(
    msg: CollectMessage,
    papers: ScoredPaper[],
    failure: string | null,
    searchTerms?: string[],
    report?: CollectReport,
  ): Promise<void>;
  knownExternalIds(projectId: string): Promise<Set<string>>;
};

export type SearchQueryBuilder = {
  build(summary: string, confirmed?: readonly string[]): Promise<SearchTerms>;
};

export type CollectUsage = {
  /** 利用者単位の1日あたり上限（NFR-04・ADR-0005 §7）を LLM 呼び出し前に見る。true なら呼び出してよい */
  checkLimit(msg: CollectMessage): Promise<boolean>;
  recordSearch(msg: CollectMessage, usage: OrcaChatOk): Promise<void>;
  recordReview(msg: CollectMessage, usage: OrcaChatOk): Promise<void>;
  recordTrend?(msg: CollectMessage, usage: OrcaChatOk): Promise<void>;
};

export type ProblemExcerptPort = {
  attach(papers: ScoredPaper[]): Promise<{ papers: ScoredPaper[]; usage: OrcaChatOk | null }>;
};

export type CollectTrendPort = {
  analyze(
    summary: string,
    papers: ScoredPaper[],
  ): Promise<{ report: CollectReport; usage: OrcaChatOk | null }>;
};

export type IngestDeps = {
  papers: PaperFetcher;
  runs: RunStore;
  search: SearchQueryBuilder;
  problemExcerpt: ProblemExcerptPort;
  usage: CollectUsage;
  trend: CollectTrendPort;
};
