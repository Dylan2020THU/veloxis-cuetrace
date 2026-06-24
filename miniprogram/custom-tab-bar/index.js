// 自定义底部导航：根据当前登录身份动态渲染不同的 tab
// 球员端：打卡 / 社区 / 约球 / 记录 / 我的
// 教练端：打卡 / 社区 / 记录 / 我的学员 / 我的
// 店主端：球厅态势 / 教练 / 会员 / 球桌 / 我的

const mock = require('../utils/mock');

// 线性描边图标（参照设计图风格），通过 CSS mask 渲染，颜色由样式控制
const SVG = {
  checkin:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='18' rx='2'/><path d='M16 2v4M8 2v4M3 10h18'/><path d='M8.5 16l2.5 2.5L16 13'/></svg>",
  community:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'/></svg>",
  match:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><circle cx='12' cy='12' r='3' fill='black' stroke='none'/></svg>",
  record:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><line x1='9' y1='6' x2='21' y2='6'/><line x1='9' y1='12' x2='21' y2='12'/><line x1='9' y1='18' x2='21' y2='18'/><circle cx='4' cy='6' r='1' fill='black' stroke='none'/><circle cx='4' cy='12' r='1' fill='black' stroke='none'/><circle cx='4' cy='18' r='1' fill='black' stroke='none'/></svg>",
  profile:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/></svg>",
  students:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.87'/><path d='M16 3.13a4 4 0 0 1 0 7.75'/></svg>",
  activity:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M22 12h-4l-3 9L9 3l-3 9H2'/></svg>",
  necktie:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M10 3 L14 3 L13 7 L15 16 L12 21 L9 16 L11 7 Z'/></svg>",
  layoutgrid:
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='3' width='7' height='7' rx='1'/><rect x='14' y='3' width='7' height='7' rx='1'/><rect x='14' y='14' width='7' height='7' rx='1'/><rect x='3' y='14' width='7' height='7' rx='1'/></svg>"
};

function icon(name) {
  // encodeURIComponent 不会转义单引号，而 SVG 内使用了单引号属性，
  // 直接用在 url('...') 中会被提前截断，需手动转义为 %27
  return 'data:image/svg+xml,' + encodeURIComponent(SVG[name]).replace(/'/g, '%27');
}

const TABS = {
  member: [
    { path: '/pages/checkin/index', text: '杆迹', icon: icon('checkin') },
    { path: '/pages/community/index', text: '社区', icon: icon('community') },
    { path: '/pages/match/index', text: '约球', icon: icon('match') },
    { path: '/pages/training/add', text: '记录', icon: icon('record') },
    { path: '/pages/profile/index', text: '我的', icon: icon('profile') }
  ],
  coach: [
    { path: '/pages/checkin/index', text: '杆迹', icon: icon('checkin') },
    { path: '/pages/community/index', text: '社区', icon: icon('community') },
    { path: '/pages/training/add', text: '记录', icon: icon('record') },
    { path: '/pages/coach/members/index', text: '我的学员', icon: icon('students') },
    { path: '/pages/profile/index', text: '我的', icon: icon('profile') }
  ],
  // 店主端：球厅态势 / 教练 / 会员 / 球桌 / 我的
  shop: [
    { path: '/pages/shop/hall-status/index', text: '球厅', icon: icon('activity') },
    { path: '/pages/shop/coaches/index', text: '教练', icon: icon('necktie') },
    { path: '/pages/shop/members/index', text: '会员', icon: icon('students') },
    { path: '/pages/shop/table-types/index', text: '球桌', icon: icon('layoutgrid') },
    { path: '/pages/profile/index', text: '我的', icon: icon('profile') }
  ]
};

function currentRoute() {
  const pages = getCurrentPages();
  if (!pages.length) return '';
  const route = pages[pages.length - 1].route || '';
  return route.startsWith('/') ? route : '/' + route;
}

Component({
  data: {
    list: TABS.member,
    // 用路径标记选中项（避免 wxml 里 index 与 selected 的 === 比较失效）
    activePath: '',
    theme: 'light',
    // 仅店主端显示黄铜菱形选中指示点
    isShop: false
  },

  lifetimes: {
    attached() {
      this.refresh();
    }
  },

  pageLifetimes: {
    show() {
      this.refresh();
    }
  },

  methods: {
    refresh() {
      const app = getApp();
      // 角色以持久化的 mock.getRole()(storage 'dc_role') 为准：globalData.role 在 mock 登录态下
      // 可能未写、冷启动也会丢失，会导致店主底栏错用球员 tab、选中态不跟随。
      const role = mock.getRole() || (app && app.globalData && app.globalData.role) || 'member';
      const theme = (app && app.globalData && app.globalData.theme) || 'light';
      const list = TABS[role] || TABS.member;

      const route = currentRoute();
      let activePath = route;
      if (!list.some((t) => t.path === route)) {
        activePath = list[0] ? list[0].path : '';
      }

      this.setData({ list, activePath, theme, isShop: role === 'shop' });
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path;
      if (!path || path === this.data.activePath) return;
      // 点击时立即高亮，不等待 switchTab 完成
      this.setData({ activePath: path });
      wx.switchTab({
        url: path,
        fail: () => this.refresh()
      });
    }
  }
});
