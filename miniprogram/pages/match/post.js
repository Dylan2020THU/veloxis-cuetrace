const data = require('../../services/data.js');

const GAME_TYPES = ['中式八球', '斯诺克', '九球', '美式十六球', '不限'];
const TIME_OPTIONS = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '21:00'];

function buildDateOptions() {
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const out = [];
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const md = `${d.getMonth() + 1}月${d.getDate()}日`;
    const label = i === 0 ? `今天 ${md}` : i === 1 ? `明天 ${md}` : `周${week[d.getDay()]} ${md}`;
    out.push(label);
  }
  return out;
}

Page({
  behaviors: [require('../../utils/themeBehavior')],
  data: {
    halls: [],
    hallIndex: 0,
    gameTypes: GAME_TYPES,
    gameIndex: 0,
    dateOptions: buildDateOptions(),
    timeOptions: TIME_OPTIONS,
    dateIndex: 0,
    timeIndex: 4,
    note: '',
    submitting: false
  },

  onLoad() {
    data.getHalls().then((halls) => this.setData({ halls }));
  },

  onHall(e) {
    this.setData({ hallIndex: Number(e.detail.value) });
  },
  onGame(e) {
    this.setData({ gameIndex: Number(e.detail.value) });
  },
  onDate(e) {
    this.setData({ dateIndex: Number(e.detail.value) });
  },
  onTime(e) {
    this.setData({ timeIndex: Number(e.detail.value) });
  },
  onNote(e) {
    this.setData({ note: e.detail.value });
  },

  submit() {
    if (this.data.submitting) return;
    const hall = this.data.halls[this.data.hallIndex];
    if (!hall) {
      wx.showToast({ title: '请选择球厅', icon: 'none' });
      return;
    }
    const datetime = `${this.data.dateOptions[this.data.dateIndex]} ${this.data.timeOptions[this.data.timeIndex]}`;
    this.setData({ submitting: true });
    data
      .createMatchPost({
        hallId: hall._id,
        hallName: hall.name,
        datetime,
        gameType: this.data.gameTypes[this.data.gameIndex],
        note: this.data.note
      })
      .then(() => {
        wx.showToast({ title: '发布成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch(() => {
        this.setData({ submitting: false });
        wx.showToast({ title: '发布失败', icon: 'none' });
      });
  }
});
