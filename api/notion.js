const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const TODO_DB_ID = process.env.NOTION_TODO_DB_ID;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ─────────────────────────────────────────────
    // getTodos: 특정 월의 TODO 항목 조회
    // query params: year, month (1-indexed)
    // ─────────────────────────────────────────────
    if (action === 'getTodos') {
      const year  = parseInt(req.query.year)  || new Date().getFullYear();
      const month = parseInt(req.query.month) || new Date().getMonth() + 1;

      // KST 기준 해당 월 전체 범위
      // 캘린더는 전월 말일 ~ 다음월 초일까지 날짜가 보일 수 있으므로 ±7일 여유
      const startDate = new Date(year, month - 1, 1);
      startDate.setDate(startDate.getDate() - 7);
      const endDate = new Date(year, month, 1);
      endDate.setDate(endDate.getDate() + 7);

      const startISO = startDate.toISOString().split('T')[0];
      const endISO   = endDate.toISOString().split('T')[0];

      const response = await notion.dataSources.query({
        data_source_id: TODO_DB_ID,
        filter: {
          and: [
            {
              property: '데드라인',
              date: { on_or_after: startISO }
            },
            {
              property: '데드라인',
              date: { before: endISO }
            }
          ]
        },
        sorts: [
          { property: '데드라인', direction: 'ascending' }
        ]
      });

      const todos = response.results.map(page => {
        const props = page.properties;

        // 완료 상태 (status 속성 "🪐")
        const statusName = props['🪐']?.status?.name || null;

        // Priority (선택 속성, 볼드 유니코드)
        const priority = props['𝑷𝒓𝒊𝒐𝒓𝒊𝒕𝒚']?.select?.name || null;

        // 그룹mode (선택 속성, 볼드 유니코드)
        const groupMode = props['그룹\uD835\uDDF4\uD835\uDDFC\uD835\uDDF1\uD835\uDDF2']?.select?.name || null;

        // 타임블록 요약 (formula 속성)
        const timeBlock = props['타임블록 요약']?.formula?.string || null;

        return {
          id: page.id,
          title: props['리스트']?.title?.[0]?.plain_text || '(제목 없음)',
          deadline: props['데드라인']?.date?.start || null,
          status: statusName,
          priority: priority,
          groupMode: groupMode,
          timeBlock: timeBlock,
          url: page.url
        };
      });

      return res.json({ todos });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('[Notion API Error]', error);
    return res.status(500).json({ error: error.message });
  }
};
