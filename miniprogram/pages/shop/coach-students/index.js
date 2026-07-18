const data = require('../../../services/data');

Page({
  behaviors: [require('../../../utils/themeBehavior')],
  data: {
    coachOpenid: '',
    coachName: '',
    students: [],
    loading: true
  },

  onLoad(query) {
    const coachOpenid = decodeURIComponent(query.openid || '');
    const coachName = decodeURIComponent(query.nickname || '');
    this.setData({ coachOpenid, coachName });
    wx.setNavigationBarTitle({ title: coachName ? `${coachName}的学员` : '教练学员' });
    this.loadStudents();
  },

  loadStudents() {
    this.setData({ loading: true });
    data.getCoachStudents(this.data.coachOpenid).then((students) => {
      this.setData({ students: students || [], loading: false });
    });
  },

  // 点击学员，查看其训练数据（复用教练端「学员训练数据」页）
  viewStudent(e) {
    const { openid, nickname } = e.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/coach/member/index?openid=${encodeURIComponent(
        openid
      )}&nickname=${encodeURIComponent(nickname)}`
    });
  }
});
