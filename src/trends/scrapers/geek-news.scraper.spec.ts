import { Test, TestingModule } from '@nestjs/testing';
import { GeekNewsScraper } from './geek-news.scraper';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GeekNewsScraper', () => {
  let scraper: GeekNewsScraper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GeekNewsScraper],
    }).compile();

    scraper = module.get<GeekNewsScraper>(GeekNewsScraper);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getArticles', () => {
    it('성공: RSS 피드를 성공적으로 파싱하여 아티클 목록을 반환해야 한다', async () => {
      const mockFeed = {
        items: [
          {
            title: ' GeekNews 소식 ',
            link: 'https://news.hada.io/topic?id=12345',
            pubDate: 'Mon, 01 Jan 2026 00:00:00 GMT',
          },
        ],
      };

      // internal parser mocking
      jest.spyOn((scraper as any).parser, 'parseURL').mockResolvedValueOnce(mockFeed);

      const result = await scraper.getArticles();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: '12345',
        title: 'GeekNews 소식',
        url: 'https://news.hada.io/topic?id=12345',
        created_at: '2026-01-01',
        source: 'geeknews',
      });
    });
  });

  describe('getArticleDetails', () => {
    it('성공: HTML을 Cheerio로 파싱하여 본문, 포인트, 댓글 수를 추출해야 한다', async () => {
      const mockHtml = `
        <html>
          <body>
            <div class="topic_contents">긱뉴스 상세 본문입니다.</div>
            <div> 15 P by GN+ </div>
            <div> 댓글 3 개 </div>
          </body>
        </html>
      `;

      mockedAxios.get.mockResolvedValueOnce({ data: mockHtml });

      const result = await scraper.getArticleDetails('12345');

      expect(result).toEqual({
        content: '긱뉴스 상세 본문입니다.',
        like_count: 15,
        comment_count: 3,
      });
    });

    it('본문 요소가 없으면 null을 반환해야 한다', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: '<html><body></body></html>' });

      const result = await scraper.getArticleDetails('12345');
      expect(result).toBeNull();
    });
  });
});