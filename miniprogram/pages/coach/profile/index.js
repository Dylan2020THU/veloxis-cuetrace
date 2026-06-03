const data = require('../../../services/data');

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    weekdays: WEEKDAYS,
    avatar: '',
    nickname: '',
    playYears: '',
    coachYears: '',
    intro: '',
    pricePerMinute: '',
    certificates: [],
    availability: [],
    // 新增时段的临时表单
    slotWeekday: 0,
    slotStart: '18:00',
    slotEnd: '21:00',
    submitting: false
  },

  onLoad() {
    data.getCoachProfile().then((p) => {
      if (!p) return;
      this.setData({
        avatar: p.avatar || '',
        nickname: p.nickname || '',
        playYears: p.playYears || '',
        coachYears: p.coachYears || '',
        intro: p.intro || '',
        pricePerMinute: p.pricePerMinute || '',
        certificates: p.certificates || [],
        availability: p.availability || []
      });
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const tempPath = res.tempFiles[0].tempFilePath;
        wx.showLoading({ title: '上传中' });
        data
          .uploadImage(tempPath)
          .then((url) => this.setData({ avatar: url }))
          .finally(() => wx.hideLoading());
      }
    });
  },

  chooseCertificate() {
    const remain = 6 - this.data.certificates.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多 6 张', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        wx.showLoading({ title: '上传中' });
        Promise.all(paths.map((p) => data.uploadImage(p)))
          .then((urls) => {
            this.setData({ certificates: this.data.certificates.concat(urls) });
          })
          .finally(() => wx.hideLoading());
      }
    });
  },

  removeCertificate(e) {
    const idx = e.currentTarget.dataset.index;
    const certificates = this.data.certificates.slice();
    certificates.splice(idx, 1);
    this.setData({ certificates });
  },

  previewCertificate(e) {
    const idx = e.currentTarget.dataset.index;
    wx.previewImage({ current: this.data.certificates[idx], urls: this.data.certificates });
  },

  onSlotWeekday(e) {
    this.setData({ slotWeekday: Number(e.detail.value) });
  },
  onSlotStart(e) {
    this.setData({ slotStart: e.detail.value });
  },
  onSlotEnd(e) {
    this.setData({ slotEnd: e.detail.value });
  },

  addSlot() {
    const { slotWeekday, slotStart, slotEnd } = this.data;
    if (slotStart >= slotEnd) {
      wx.showToast({ title: '结束需晚于开始', icon: 'none' });
      return;
    }
    const slot = {
      weekday: slotWeekday,
      weekdayLabel: WEEKDAYS[slotWeekday],
      start: slotStart,
      end: slotEnd
    };
    this.setData({ availability: this.data.availability.concat(slot) });
  },

  removeSlot(e) {
    const idx = e.currentTarget.dataset.index;
    const availability = this.data.availability.slice();
    availability.splice(idx, 1);
    this.setData({ availability });
  },

  submit() {
    if (this.data.submitting) return;
    const { nickname, intro, pricePerMinute } = this.data;
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    if (!pricePerMinute || Number(pricePerMinute) <= 0) {
      wx.showToast({ title: '请填写收费标准', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    data
      .saveCoachProfile({
        nickname,
        playYears: this.data.playYears,
        coachYears: this.data.coachYears,
        avatar: this.data.avatar,
        certificates: this.data.certificates,
        intro,
        availability: this.data.availability,
        pricePerMinute
      })
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      })
      .catch((err) => {
        console.error('保存教练资料失败', err);
        wx.showToast({ title: '保存失败', icon: 'none' });
      })
      .finally(() => this.setData({ submitting: false }));
  }
});
