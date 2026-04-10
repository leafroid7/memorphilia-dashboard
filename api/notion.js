const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const TODO_DB_ID        = process.env.NOTION_TODO_DB_ID;
const ACTION_PLAN_DB_ID = process.env.NOTION_ACTION_PLAN_DB_ID;

// 고정 페이지 ID
const IMSI_MEMO_PAGE_ID   = '33eec7e5-b9b0-8069-bee2-e9ce7e1ab0d6'; // 임시 메모
const DAILY_STATS_PAGE_ID = '30bec7e5-b9b0-8063-908f-c001ffb33dbb'; // Daily statistics

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    // ── getTodos: 월별 조회 ─────────────────────────
    if (action === 'getTodos') {
      const year  = parseInt(req.query.year)  || new Date().getFullYear();
      const month = parseInt(req.query.month) || new Date().getMonth() + 1;

      const startDate = new Date(year, month - 1, 1);
      startDate.setDate(startDate.getDate() - 7);
      const endDate = new Date(year, month, 1);
      endDate.setDate(endDate.getDate() + 7);

      const response = await notion.dataSources.query({
        data_source_id: TODO_DB_ID,
        filter: {
          and: [
            { property: '데드라인', date: { on_or_after: startDate.toISOString().split('T')[0] } },
            { property: '데드라인', date: { before:      endDate.toISOString().split('T')[0]  } }
          ]
        },
        sorts: [{ property: '데드라인', direction: 'ascending' }]
      });

      return res.json({ todos: response.results.map(mapTodo) });
    }

    // ── searchTodos: 제목 검색 ──────────────────────
    if (action === 'searchTodos') {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ todos: [] });

      const response = await notion.dataSources.query({
        data_source_id: TODO_DB_ID,
        filter: { property: '리스트', title: { contains: q } },
        sorts:  [{ property: '데드라인', direction: 'descending' }]
      });

      return res.json({ todos: response.results.slice(0, 20).map(mapTodo) });
    }

    // ── getPageDetail: 단일 페이지 상세 (액션플랜 이름 포함) ──
    if (action === 'getPageDetail') {
      const pageId = req.query.pageId;
      if (!pageId) return res.status(400).json({ error: 'pageId required' });

      const page = await notion.pages.retrieve({ page_id: pageId });
      const todo = mapTodo(page);

      // 액션 플랜 relation → 이름 조회
      const apIds = page.properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎']?.relation?.map(r => r.id) || [];
      const actionPlans = [];
      for (const id of apIds.slice(0, 3)) {
        try {
          const ap = await notion.pages.retrieve({ page_id: id });
          const title = ap.properties['Action']?.title?.[0]?.plain_text ||
                        Object.values(ap.properties).find(p => p.type === 'title')
                          ?.title?.[0]?.plain_text || '(제목 없음)';
          const icon = ap.icon?.type === 'emoji' ? ap.icon.emoji : null;
          actionPlans.push({ id, title, icon });
        } catch { /* 조회 실패 시 스킵 */ }
      }

      return res.json({ todo: { ...todo, actionPlans } });
    }

    // ── getActionPlans: 드롭다운용 ──────────────────
    if (action === 'getActionPlans') {
      const q = (req.query.q || '').trim();
      const queryParams = {
        data_source_id: ACTION_PLAN_DB_ID,
        sorts: [{ property: 'Action', direction: 'ascending' }]
      };
      if (q) queryParams.filter = { property: 'Action', title: { contains: q } };

      const response = await notion.dataSources.query(queryParams);
      const plans = response.results.map(page => ({
        id:    page.id,
        title: page.properties['Action']?.title?.[0]?.plain_text || '(제목 없음)',
        icon:  page.icon?.type === 'emoji' ? page.icon.emoji : null
      }));
      return res.json({ plans });
    }

    // ── createTodo: 새 Todo 생성 ────────────────────
    if (action === 'createTodo') {
      const { title, priority, deadline, actionPlanId, isMemo, note, est } = req.body;

      if (!title?.trim()) return res.status(400).json({ error: '제목을 입력해주세요.' });

      const properties = {
        '리스트': { title: [{ text: { content: title.trim() } }] }
      };

      if (deadline) properties['데드라인'] = { date: { start: deadline } };
      if (priority) properties['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚'] = { select: { name: priority } };
      if (note?.trim()) properties['비고'] = { rich_text: [{ text: { content: note.trim() } }] };
      if (est !== undefined && est !== null) properties['est.'] = { number: Number(est) };

      // Action Plan 관계형
      const apRelation = isMemo
        ? [{ id: IMSI_MEMO_PAGE_ID }]          // 메모: 임시 메모 고정
        : actionPlanId ? [{ id: actionPlanId }] : [];
      if (apRelation.length > 0) {
        properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎'] = { relation: apRelation };
      }

      // Time Statistics: 할일만 연결 (메모는 제외)
      if (!isMemo) {
        properties['Time Statistics'] = { relation: [{ id: DAILY_STATS_PAGE_ID }] };
      }

      const page = await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: TODO_DB_ID },
        properties
      });

      return res.json({ success: true, id: page.id, url: page.url });
    }

    // ── updateTodo: 속성 업데이트 (Start/End/Status/비고/est) ──
    if (action === 'updateTodo') {
      const { pageId, updates } = req.body;
      if (!pageId) return res.status(400).json({ error: 'pageId required' });

      const properties = {};

      // 상태
      if (updates.status !== undefined) {
        properties['🪐'] = { status: { name: updates.status } };
      }
      // Start Time (date 속성)
      if (updates.startTime !== undefined) {
        properties['Start Time'] = updates.startTime
          ? { date: { start: updates.startTime } }
          : { date: null };
      }
      // End Time (date 속성)
      if (updates.endTime !== undefined) {
        properties['End Time'] = updates.endTime
          ? { date: { start: updates.endTime } }
          : { date: null };
      }
      // 비고
      if (updates.note !== undefined) {
        properties['비고'] = { rich_text: [{ text: { content: updates.note || '' } }] };
      }
      // est.
      if (updates.est !== undefined) {
        properties['est.'] = updates.est !== null ? { number: Number(updates.est) } : { number: null };
      }

      await notion.pages.update({ page_id: pageId, properties });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('[Notion API Error]', error);
    return res.status(500).json({ error: error.message });
  }
};

// ── 공통 매핑 ─────────────────────────────────
function mapTodo(page) {
  const p = page.properties;
  return {
    id:        page.id,
    title:     p['리스트']?.title?.[0]?.plain_text || '(제목 없음)',
    deadline:  p['데드라인']?.date?.start || null,
    status:    p['🪐']?.status?.name || null,
    priority:  p['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚']?.select?.name || null,
    groupMode: p['그룹\uD835\uDDF4\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2']?.select?.name || null,
    timeBlock: p['타임블록 요약']?.formula?.string || null,
    note:      p['비고']?.rich_text?.[0]?.plain_text || null,
    est:       p['est.']?.number ?? null,
    startTime: p['Start Time']?.date?.start || null,
    endTime:   p['End Time']?.date?.start || null,
    url:       page.url
  };
}
