const data = require('../../services/data');
const { today, toKey } = require('../../utils/date');

Page({
  data: {
    halls: [],
    hallNames: [],
    hallIndex: 0,
    date: '',
    startTime: '15:00',
    hours: 1,
    minutes: 30,
    submitting: false
  },

  onLoad() {
    this.setData({ date: toKey(today()) });
    data.getHalls().then((halls) => {
      this.setData({
        halls,
        hallNames: halls.map((h) => h.name)
      });
    });
  },

  onHallChange(e) {
    this.setData({ hallIndex: Number(e.detail.value) });
  },

  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ startTime: e.detail.value });
  },

  onHoursInput(e) {
    this.setData({ hours: this.clampNum(e.detail.value, 0, 24) });
  },

  onMinutesInput(e) {
    this.setData({ minutes: this.clampNum(e.detail.value, 0, 59) });
  },

  clampNum(v, min, max) {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = 0;
    return Math.max(min, Math.min(max, n));
  },

  submit() {
    const { halls, hallIndex, date, startTime, hours, minutes, submitting } = this.data;
    if (submitting) return;

    const durationMinutes = hours * 60 + minutes;
    if (durationMinutes <= 0) {
      wx.showToast({ title: '请填写训练时长', icon: 'none' });
      return;
    }
    if (!halls.length) {
      wx.showToast({ title: '暂无台球厅数据', icon: 'none' });
      return;
    }

    const hall = halls[hallIndex];
    this.setData({ submitting: true });
    data
      .addTraining({
        hallId: hall._id,
        hallName: hall.name,
        date,
        startTime,
        durationMinutes
      })
      .then(() => {
        wx.showToast({ title: '记录成功', icon: 'success' });
        setTimeout(() => {
          wx.switchTab({ url: '/pages/checkin/index' });
        }, 600);
      })
      .catch((err) => {
        console.error('记录失败', err);
        wx.showToast({ title: '记录失败', icon: 'none' });
      })
      .finally(() => {
        this.setData({ submitting: false });
      });
  }
});
