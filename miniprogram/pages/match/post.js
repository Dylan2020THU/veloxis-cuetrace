const data = require('../../services/data.js');

const GAME_TYPES = ['中式八球', '斯诺克', '九球', '美式十六球', '不限'];

// 档位表：0~11级，对应不同水平描述
const LEVELS = [
  '0级（纯萌新）', '1级（入门）', '2级（新手）', '3级（初学者）',
  '4级（爱好者）', '5级（业余中级）', '6级（业余进阶）',
  '7级（业余高手）', '8级（业余强手）', '9级（业余强者）',
  '10级（业余顶尖）', '11级（职业）'
];

const GENDER_OPTIONS = ['男', '女'];

const AGE_OPTIONS = [
  '11岁以下', '12-18岁', '19-25岁', '26-32岁',
  '33-39岁', '40-46岁', '47-53岁', '54-60岁', '60岁以上'
];

const TIME_OPTIONS = ['00:00','01:00','02:00','03:00','04:00','05:00','06:00','07:00','08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00','21:00','22:00','23:00'];

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
    levels: LEVELS,
    myLevelIndex: 0,
    targetLevelIndex: 0,
    genderOptions: GENDER_OPTIONS,
    genderIndex: 0,
    ageOptions: AGE_OPTIONS,
    ageIndex: 0,
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
  onMyLevel(e) {
    this.setData({ myLevelIndex: Number(e.detail.value) });
  },
  onTargetLevel(e) {
    this.setData({ targetLevelIndex: Number(e.detail.value) });
  },
  onGender(e) {
    this.setData({ genderIndex: Number(e.detail.value) });
  },
  onAge(e) {
    this.setData({ ageIndex: Number(e.detail.value) });
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
        myLevel: this.data.levels[this.data.myLevelIndex],
        targetLevel: this.data.levels[this.data.targetLevelIndex],
        gender: this.data.genderOptions[this.data.genderIndex],
        age: this.data.ageOptions[this.data.ageIndex],
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
