const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const TODO_DB_ID        = process.env.NOTION_TODO_DB_ID;
const ACTION_PLAN_DB_ID = process.env.NOTION_ACTION_PLAN_DB_ID;

const IMSI_MEMO_PAGE_ID  = '33eec7e5-b9b0-8069-bee2-e9ce7e1ab0d6';
const DAILY_STATS_PAGE_ID = '30bec7e5-b9b0-8063-908f-c001ffb33dbb';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    // ── getTodos ──────────────────────────────────
    if (action === 'getTodos') {
      const year  = parseInt(req.query.year)  || new Date().getFullYear();
      const month = parseInt(req.query.month) || new Date().getMonth() + 1;

      const pad = v => String(v).padStart(2, '0');
      const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

      const s = new Date(year, month - 1, 1); s.setDate(s.getDate() - 7);
      const e = new Date(year, month, 1);     e.setDate(e.getDate() + 7);

      // 노션 API 100개 제한 → 페이지네이션으로 전체 조회
      let allResults = [];
      let cursor = undefined;
      do {
        const params = {
          data_source_id: TODO_DB_ID,
          filter: { and: [
            { property: '데드라인', date: { on_or_after: fmtDate(s) } },
            { property: '데드라인', date: { before:      fmtDate(e) } }
          ]},
          sorts: [{ property: '데드라인', direction: 'ascending' }],
          page_size: 100,
        };
        if (cursor) params.start_cursor = cursor;
        const response = await notion.dataSources.query(params);
        allResults = allResults.concat(response.results);
        cursor = response.has_more ? response.next_cursor : undefined;
      } while (cursor);

      return res.json({ todos: allResults.map(mapTodo) });
    }

    // ── searchTodos ───────────────────────────────
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

    // ── getPageDetail ─────────────────────────────
    if (action === 'getPageDetail') {
      const pageId = req.query.pageId;
      if (!pageId) return res.status(400).json({ error: 'pageId required' });
      const page = await notion.pages.retrieve({ page_id: pageId });
      const todo = mapTodo(page);
      const apIds = page.properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎']?.relation?.map(r => r.id) || [];
      const actionPlans = [];
      for (const id of apIds.slice(0, 3)) {
        try {
          const ap = await notion.pages.retrieve({ page_id: id });
          const title = ap.properties['Action']?.title?.[0]?.plain_text ||
            Object.values(ap.properties).find(p => p.type === 'title')?.title?.[0]?.plain_text || '(제목 없음)';
          actionPlans.push({ id, title, icon: ap.icon?.type === 'emoji' ? ap.icon.emoji : null });
        } catch {}
      }
      return res.json({ todo: { ...todo, actionPlans } });
    }

    // ── getActionPlans ────────────────────────────
    if (action === 'getActionPlans') {
      const q = (req.query.q || '').trim();
      const params = {
        data_source_id: ACTION_PLAN_DB_ID,
        sorts: [{ property: 'Action', direction: 'ascending' }]
      };
      if (q) params.filter = { property: 'Action', title: { contains: q } };
      const response = await notion.dataSources.query(params);
      return res.json({ plans: response.results.map(p => ({
        id:    p.id,
        title: p.properties['Action']?.title?.[0]?.plain_text || '(제목 없음)',
        icon:  p.icon?.type === 'emoji' ? p.icon.emoji : null
      }))});
    }

    // ── createTodo ────────────────────────────────
    if (action === 'createTodo') {
      const { title, priority, deadline, actionPlanId, isMemo, note, est, groupMode } = req.body;
      if (!title?.trim()) return res.status(400).json({ error: '제목을 입력해주세요.' });

      const properties = {
        '리스트': { title: [{ text: { content: title.trim() } }] }
      };
      if (deadline)         properties['데드라인']  = { date: { start: deadline } };
      if (priority)         properties['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚'] = { select: { name: priority } };
      if (note?.trim())     properties['비고']       = { rich_text: [{ text: { content: note.trim() } }] };
      if (est != null)      properties['est.']       = { number: Number(est) };
      if (groupMode?.trim()) properties['그룹\uD835\uDDFA\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2'] = { select: { name: groupMode.trim() } };

      const apRelation = isMemo ? [{ id: IMSI_MEMO_PAGE_ID }]
        : actionPlanId ? [{ id: actionPlanId }] : [];
      if (apRelation.length) properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎'] = { relation: apRelation };
      if (!isMemo) properties['Time Statistics'] = { relation: [{ id: DAILY_STATS_PAGE_ID }] };

      const page = await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: TODO_DB_ID },
        properties
      });
      return res.json({ success: true, id: page.id, url: page.url });
    }

    // ── updateTodo ────────────────────────────────
    if (action === 'updateTodo') {
      const { pageId, updates } = req.body;
      if (!pageId) return res.status(400).json({ error: 'pageId required' });

      const properties = {};
      if (updates.status !== undefined)
        properties['🪐'] = { status: { name: updates.status } };

      if (updates.startTime !== undefined)
        properties['Start Time'] = updates.startTime ? { date: { start: updates.startTime } } : { date: null };
      if (updates.endTime !== undefined)
        properties['End Time'] = updates.endTime ? { date: { start: updates.endTime } } : { date: null };

      // 데드라인 범위 업데이트 (start~end)
      if (updates.deadline !== undefined) {
        if (updates.deadline === null) {
          properties['데드라인'] = { date: null };
        } else if (updates.deadlineEnd) {
          properties['데드라인'] = { date: { start: updates.deadline, end: updates.deadlineEnd } };
        } else {
          properties['데드라인'] = { date: { start: updates.deadline } };
        }
      }

      if (updates.groupMode !== undefined)
        properties['그룹\uD835\uDDFA\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2'] = { select: updates.groupMode ? { name: updates.groupMode } : null };
      if (updates.note !== undefined)
        properties['비고'] = { rich_text: [{ text: { content: updates.note || '' } }] };
      if (updates.est !== undefined)
        properties['est.'] = updates.est != null ? { number: Number(updates.est) } : { number: null };
      if (updates.actionPlanId !== undefined) {
        properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎'] = updates.actionPlanId
          ? { relation: [{ id: updates.actionPlanId }] }
          : { relation: [] };
      }

      await notion.pages.update({ page_id: pageId, properties });
      return res.json({ success: true });
    }

    // ── getMemos: 임시 메모 목록 (모드 전환용) ──────────
    if (action === 'getMemos') {
      const response = await notion.dataSources.query({
        data_source_id: TODO_DB_ID,
        filter: {
          property: '𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎',
          relation: { contains: IMSI_MEMO_PAGE_ID }
        },
        sorts: [{ timestamp: 'created_time', direction: 'descending' }]
      });
      return res.json({ todos: response.results.map(mapTodo) });
    }

    // ── archiveTodo: 페이지 아카이브(삭제) ───────────
    if (action === 'archiveTodo') {
      const { pageId } = req.body;
      if (!pageId) return res.status(400).json({ error: 'pageId required' });
      await notion.pages.update({ page_id: pageId, archived: true });
      return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('[Notion API Error]', error);
    return res.status(500).json({ error: error.message });
  }
};

function mapTodo(page) {
  const p = page.properties;
  const dl = p['데드라인']?.date;
  return {
    id:          page.id,
    title:       p['리스트']?.title?.[0]?.plain_text || '(제목 없음)',
    deadline:    dl?.start || null,
    deadlineEnd: dl?.end   || null,
    status:      p['🪐']?.status?.name || null,
    priority:    p['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚']?.select?.name || null,
    groupMode:   p['그룹\uD835\uDDFA\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2']?.select?.name || null,
    // 소요시간: 타임블록(𝗵) (표시) = 파란 메인, Tracker = 회색 서브
    timeBlockH:  p['타임블록(\uD835\uDDF5) (표시)']?.formula?.string || null,
    tracker:     p['Tracker']?.formula?.string || null,
    timeBlock:   p['타임블록 요약']?.formula?.string || null, // 하위호환 유지
    note:        p['비고']?.rich_text?.[0]?.plain_text || null,
    est:         p['est.']?.number ?? null,
    startTime:   p['Start Time']?.date?.start || null,
    endTime:     p['End Time']?.date?.start   || null,
    url:         page.url
  };
}
