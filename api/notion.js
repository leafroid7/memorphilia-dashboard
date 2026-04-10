const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const TODO_DB_ID        = process.env.NOTION_TODO_DB_ID;
const ACTION_PLAN_DB_ID = process.env.NOTION_ACTION_PLAN_DB_ID;
const STATS_DB_ID       = process.env.NOTION_STATS_DB_ID;

// 딴짓집합소 페이지 ID (Action Plan 관계형 자동 연결용)
const DDANJIT_PAGE_ID = '3abdfe30-792c-484a-adec-bab7d9474a07';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {

    // ────────────────────────────────────────────────
    // getTodos: 특정 월 TODO 조회
    // ────────────────────────────────────────────────
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
            { property: '데드라인', date: { before: endDate.toISOString().split('T')[0] } }
          ]
        },
        sorts: [{ property: '데드라인', direction: 'ascending' }]
      });

      const todos = response.results.map(page => mapTodo(page));
      return res.json({ todos });
    }

    // ────────────────────────────────────────────────
    // searchTodos: 제목 검색
    // ────────────────────────────────────────────────
    if (action === 'searchTodos') {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ todos: [] });

      const response = await notion.dataSources.query({
        data_source_id: TODO_DB_ID,
        filter: {
          property: '리스트',
          title: { contains: q }
        },
        sorts: [{ property: '데드라인', direction: 'descending' }]
      });

      const todos = response.results.slice(0, 20).map(page => mapTodo(page));
      return res.json({ todos });
    }

    // ────────────────────────────────────────────────
    // getActionPlans: 액션 플랜 목록 (드롭다운용)
    // ────────────────────────────────────────────────
    if (action === 'getActionPlans') {
      const q = (req.query.q || '').trim();

      const queryParams = {
        data_source_id: ACTION_PLAN_DB_ID,
        sorts: [{ property: 'Name', direction: 'ascending' }]
      };

      if (q) {
        queryParams.filter = {
          property: 'Name',
          title: { contains: q }
        };
      }

      const response = await notion.dataSources.query(queryParams);

      const plans = response.results.map(page => ({
        id: page.id,
        title: page.properties['Name']?.title?.[0]?.plain_text ||
               page.properties['이름']?.title?.[0]?.plain_text ||
               Object.values(page.properties).find(p => p.type === 'title')
                 ?.title?.[0]?.plain_text || '(제목 없음)',
        icon: page.icon?.type === 'emoji' ? page.icon.emoji : null
      }));

      return res.json({ plans });
    }

    // ────────────────────────────────────────────────
    // getTodayStatsId: 오늘 날짜의 Time Statistics 페이지 ID 조회
    // KST 기준 오늘 날짜로 필터
    // ────────────────────────────────────────────────
    if (action === 'getTodayStatsId') {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayStr = kstNow.toISOString().split('T')[0];

      const response = await notion.dataSources.query({
        data_source_id: STATS_DB_ID,
        filter: {
          property: '날짜',
          date: { equals: todayStr }
        }
      });

      if (!response.results.length) {
        return res.json({ statsId: null });
      }

      return res.json({ statsId: response.results[0].id });
    }

    // ────────────────────────────────────────────────
    // createTodo: 새 Todo 생성
    // body: { title, priority, deadline, actionPlanId, isMemo }
    //   - isMemo=true  → Action Plan: 딴짓집합소 고정, statsId 자동
    //   - isMemo=false → Action Plan: actionPlanId (선택), statsId 자동
    // ────────────────────────────────────────────────
    if (action === 'createTodo') {
      const { title, priority, deadline, actionPlanId, isMemo, statsId } = req.body;

      if (!title?.trim()) {
        return res.status(400).json({ error: '제목을 입력해주세요.' });
      }

      // 속성 구성
      const properties = {
        '리스트': {
          title: [{ text: { content: title.trim() } }]
        }
      };

      // 데드라인
      if (deadline) {
        properties['데드라인'] = { date: { start: deadline } };
      }

      // Priority (볼드 유니코드 속성명)
      if (priority) {
        properties['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚'] = { select: { name: priority } };
      }

      // Action Plan 관계형
      const actionPlanRelation = [];
      if (isMemo) {
        // 메모: 딴짓집합소 고정
        actionPlanRelation.push({ id: DDANJIT_PAGE_ID });
      } else if (actionPlanId) {
        actionPlanRelation.push({ id: actionPlanId });
      }

      if (actionPlanRelation.length > 0) {
        properties['𝐀𝐜𝐭𝐢𝐨𝐧 𝐏𝐥𝐚𝐧 𝒇𝒓𝒐𝒎'] = { relation: actionPlanRelation };
      }

      // Time Statistics 관계형 (항상 연결)
      if (statsId) {
        properties['Time Statistics'] = { relation: [{ id: statsId }] };
      }

      const page = await notion.pages.create({
        parent: { type: 'data_source_id', data_source_id: TODO_DB_ID },
        properties
      });

      return res.json({ success: true, id: page.id, url: page.url });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('[Notion API Error]', error);
    return res.status(500).json({ error: error.message });
  }
};

// ── 공통 Todo 매핑 함수 ──────────────────────
function mapTodo(page) {
  const props = page.properties;
  return {
    id:        page.id,
    title:     props['리스트']?.title?.[0]?.plain_text || '(제목 없음)',
    deadline:  props['데드라인']?.date?.start || null,
    status:    props['🪐']?.status?.name || null,
    priority:  props['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚']?.select?.name || null,
    groupMode: props['그룹\uD835\uDDF4\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2']?.select?.name || null,
    timeBlock: props['타임블록 요약']?.formula?.string || null,
    url:       page.url
  };
}
