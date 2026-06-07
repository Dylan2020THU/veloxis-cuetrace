const data = require('../../../../services/data');

const GENDER_OPTIONS = ['男', '女', '保密'];
const LEVELS = [
  '0级（纯萌新）', '1级（入门）', '2级（新手）', '3级（初学者）',
  '4级（爱好者）', '5级（业余中级）', '6级（业余进阶）',
  '7级（业余高手）', '8级（业余强手）', '9级（业余强者）',
  '10级（业余顶尖）', '11级（职业）'
];
const YEARS_OPTIONS = (() => {
  const arr = [];
  for (let i = 0; i <= 50; i++) arr.push(i === 0 ? '1年以下' : `${i}年`);
  return arr;
})();

// 省级 + 市级两级联动数据（籍贯专用）
const PROVINCES = [
  '北京市', '天津市', '上海市', '重庆市',
  '河北省', '山西省', '辽宁省', '吉林省', '黑龙江省',
  '江苏省', '浙江省', '安徽省', '福建省', '江西省', '山东省',
  '河南省', '湖北省', '湖南省', '广东省', '海南省',
  '四川省', '贵州省', '云南省', '陕西省', '甘肃省', '青海省', '台湾省',
  '内蒙古自治区', '广西壮族自治区', '西藏自治区', '宁夏回族自治区', '新疆维吾尔自治区',
  '香港特别行政区', '澳门特别行政区'
];
const CITIES_BY_PROVINCE = {
  '北京市': ['东城区', '西城区', '朝阳区', '丰台区', '石景山区', '海淀区', '门头沟区', '房山区', '通州区', '顺义区', '昌平区', '大兴区', '怀柔区', '平谷区', '密云区', '延庆区'],
  '天津市': ['和平区', '河东区', '河西区', '南开区', '河北区', '红桥区', '东丽区', '西青区', '津南区', '北辰区', '武清区', '宝坻区', '滨海新区', '宁河区', '静海区', '蓟州区'],
  '上海市': ['黄浦区', '徐汇区', '长宁区', '静安区', '普陀区', '虹口区', '杨浦区', '闵行区', '宝山区', '嘉定区', '浦东新区', '金山区', '松江区', '青浦区', '奉贤区', '崇明区'],
  '重庆市': ['万州区', '涪陵区', '渝中区', '大渡口区', '江北区', '沙坪坝区', '九龙坡区', '南岸区', '北碚区', '渝北区', '巴南区', '长寿区', '江津区', '合川区', '永川区', '南川区', '璧山区', '铜梁区', '潼南区', '荣昌区', '开州区', '梁平区', '武隆区'],
  '河北省': ['石家庄市', '唐山市', '秦皇岛市', '邯郸市', '邢台市', '保定市', '张家口市', '承德市', '沧州市', '廊坊市', '衡水市'],
  '山西省': ['太原市', '大同市', '阳泉市', '长治市', '晋城市', '朔州市', '晋中市', '运城市', '忻州市', '临汾市', '吕梁市'],
  '辽宁省': ['沈阳市', '大连市', '鞍山市', '抚顺市', '本溪市', '丹东市', '锦州市', '营口市', '阜新市', '辽阳市', '盘锦市', '铁岭市', '朝阳市', '葫芦岛市'],
  '吉林省': ['长春市', '吉林市', '四平市', '辽源市', '通化市', '白山市', '松原市', '白城市', '延边朝鲜族自治州'],
  '黑龙江省': ['哈尔滨市', '齐齐哈尔市', '鸡西市', '鹤岗市', '双鸭山市', '大庆市', '伊春市', '佳木斯市', '七台河市', '牡丹江市', '黑河市', '绥化市', '大兴安岭地区'],
  '江苏省': ['南京市', '无锡市', '徐州市', '常州市', '苏州市', '南通市', '连云港市', '淮安市', '盐城市', '扬州市', '镇江市', '泰州市', '宿迁市'],
  '浙江省': ['杭州市', '宁波市', '温州市', '嘉兴市', '湖州市', '绍兴市', '金华市', '衢州市', '舟山市', '台州市', '丽水市'],
  '安徽省': ['合肥市', '芜湖市', '蚌埠市', '淮南市', '马鞍山市', '淮北市', '铜陵市', '安庆市', '黄山市', '滁州市', '阜阳市', '宿州市', '六安市', '亳州市', '池州市', '宣城市'],
  '福建省': ['福州市', '厦门市', '莆田市', '三明市', '泉州市', '漳州市', '南平市', '龙岩市', '宁德市'],
  '江西省': ['南昌市', '景德镇市', '萍乡市', '九江市', '新余市', '鹰潭市', '赣州市', '吉安市', '宜春市', '抚州市', '上饶市'],
  '山东省': ['济南市', '青岛市', '淄博市', '枣庄市', '东营市', '烟台市', '潍坊市', '济宁市', '泰安市', '威海市', '日照市', '临沂市', '德州市', '聊城市', '滨州市', '菏泽市'],
  '河南省': ['郑州市', '开封市', '洛阳市', '平顶山市', '安阳市', '鹤壁市', '新乡市', '焦作市', '濮阳市', '许昌市', '漯河市', '三门峡市', '南阳市', '商丘市', '信阳市', '周口市', '驻马店市'],
  '湖北省': ['武汉市', '黄石市', '十堰市', '宜昌市', '襄阳市', '鄂州市', '荆门市', '孝感市', '荆州市', '黄冈市', '咸宁市', '随州市', '恩施土家族苗族自治州', '直辖县级行政区划'],
  '湖南省': ['长沙市', '株洲市', '湘潭市', '衡阳市', '邵阳市', '岳阳市', '常德市', '张家界市', '益阳市', '郴州市', '永州市', '怀化市', '娄底市', '湘西土家族苗族自治州'],
  '广东省': ['广州市', '韶关市', '深圳市', '珠海市', '汕头市', '佛山市', '江门市', '湛江市', '茂名市', '肇庆市', '惠州市', '梅州市', '汕尾市', '河源市', '阳江市', '清远市', '东莞市', '中山市', '潮州市', '揭阳市', '云浮市'],
  '海南省': ['海口市', '三亚市', '三沙市', '儋州市'],
  '四川省': ['成都市', '自贡市', '攀枝花市', '泸州市', '德阳市', '绵阳市', '广元市', '遂宁市', '内江市', '乐山市', '南充市', '眉山市', '宜宾市', '广安市', '达州市', '雅安市', '巴中市', '资阳市', '阿坝藏族羌族自治州', '甘孜藏族自治州', '凉山彝族自治州'],
  '贵州省': ['贵阳市', '六盘水市', '遵义市', '安顺市', '毕节市', '铜仁市', '黔西南布依族苗族自治州', '黔东南苗族侗族自治州', '黔南布依族苗族自治州'],
  '云南省': ['昆明市', '曲靖市', '玉溪市', '保山市', '昭通市', '丽江市', '普洱市', '临沧市', '楚雄彝族自治州', '红河哈尼族彝族自治州', '文山壮族苗族自治州', '西双版纳傣族自治州', '大理白族自治州', '德宏傣族景颇族自治州', '怒江傈僳族自治州', '迪庆藏族自治州'],
  '陕西省': ['西安市', '铜川市', '宝鸡市', '咸阳市', '渭南市', '延安市', '汉中市', '榆林市', '安康市', '商洛市'],
  '甘肃省': ['兰州市', '嘉峪关市', '金昌市', '白银市', '天水市', '武威市', '张掖市', '平凉市', '酒泉市', '庆阳市', '定西市', '陇南市', '临夏回族自治州', '甘南藏族自治州'],
  '青海省': ['西宁市', '海东市', '海北藏族自治州', '黄南藏族自治州', '海南藏族自治州', '果洛藏族自治州', '玉树藏族自治州', '海西蒙古族藏族自治州'],
  '台湾省': ['台北市', '新北市', '桃园市', '台中市', '台南市', '高雄市'],
  '内蒙古自治区': ['呼和浩特市', '包头市', '乌海市', '赤峰市', '通辽市', '鄂尔多斯市', '呼伦贝尔市', '巴彦淖尔市', '乌兰察布市', '兴安盟', '锡林郭勒盟', '阿拉善盟'],
  '广西壮族自治区': ['南宁市', '柳州市', '桂林市', '梧州市', '北海市', '防城港市', '钦州市', '贵港市', '玉林市', '百色市', '贺州市', '河池市', '来宾市', '崇左市'],
  '西藏自治区': ['拉萨市', '日喀则市', '昌都市', '林芝市', '山南市', '那曲市', '阿里地区'],
  '宁夏回族自治区': ['银川市', '石嘴山市', '吴忠市', '固原市', '中卫市'],
  '新疆维吾尔自治区': ['乌鲁木齐市', '克拉玛依市', '吐鲁番市', '哈密市', '昌吉回族自治州', '博尔塔拉蒙古自治州', '巴音郭楞蒙古自治州', '阿克苏地区', '克孜勒苏柯尔克孜自治州', '喀什地区', '和田地区', '伊犁哈萨克自治州', '塔城地区', '阿勒泰地区'],
  '香港特别行政区': ['中西区', '东区', '九龙城区', '观塘区', '深水埗区', '黄大仙区', '湾仔区', '离岛区', '荃湾区', '屯门区', '元朗区', '北区', '大埔区', '沙田区', '西贡区', '南区'],
  '澳门特别行政区': ['花地玛堂区', '圣安多尼堂区', '大堂区', '望德堂区', '风顺堂区', '嘉模堂区', '圣方济各堂区']
};

Page({
  behaviors: [require('../../../../utils/themeBehavior')],
  data: {
    nickname: '',
    avatar: '',
    genderIndex: 0,
    genderOptions: GENDER_OPTIONS,
    birthDate: '',
    phone: '',
    // 所在地（定位或手动选择，市级）
    locationCity: '',
    locationLoading: false,
    // 籍贯（省级+市级，两列联动）
    hometownProvinces: PROVINCES,
    hometownProvinceIndex: 0,
    hometownCityIndex: 0,
    hometownCities: [],
    hometown: ['', ''],
    // 球龄
    yearsIndex: 0,
    yearsOptions: YEARS_OPTIONS,
    // 段位
    levelIndex: 0,
    levels: LEVELS,
    submitting: false,
    // 字段可见性（开关控制是否对他人可见）
    canSeeGender: true,
    canSeeBirthDate: true,
    canSeeHometown: true
  },

  onLoad() {
    this.loadProfile();
  },

  loadProfile() {
    data.getUserProfile().then((u) => {
      if (!u) return;
      const findIndex = (arr, val) => {
        const idx = arr.indexOf(val);
        return idx >= 0 ? idx : 0;
      };
      // 初始化籍贯城市列表
      const province = (u.hometown && u.hometown[0]) || PROVINCES[0];
      const provinceIdx = findIndex(PROVINCES, province);
      const provinceVal = province || PROVINCES[0];
      const cities = CITIES_BY_PROVINCE[provinceVal] || [''];
      const city = (u.hometown && u.hometown[1]) || cities[0];
      const cityIdx = findIndex(cities, city);
      this.setData({
        nickname: u.nickname || '',
        avatar: u.avatar || '',
        genderIndex: findIndex(GENDER_OPTIONS, u.gender),
        birthDate: u.birthDate || '',
        phone: u.phone || '',
        locationCity: u.locationCity || '',
        hometown: u.hometown || [PROVINCES[0], cities[0]],
        hometownProvinceIndex: provinceIdx,
        hometownCityIndex: cityIdx,
        hometownCities: cities,
        yearsIndex: findIndex(YEARS_OPTIONS, u.years),
        levelIndex: findIndex(LEVELS, u.level),
        canSeeGender: u.canSeeGender !== undefined ? u.canSeeGender : true,
        canSeeBirthDate: u.canSeeBirthDate !== undefined ? u.canSeeBirthDate : true,
        canSeeHometown: u.canSeeHometown !== undefined ? u.canSeeHometown : true
      });
    });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  onGenderChange(e) {
    this.setData({ genderIndex: Number(e.detail.value) });
  },

  onBirthDateChange(e) {
    this.setData({ birthDate: e.detail.value });
  },

  onToggleField(e) {
    const name = e.currentTarget.dataset.name;
    this.setData({ [name]: !this.data[name] });
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  onLocateCity() {
    this.setData({ locationLoading: true });
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        wx.request({
          url: `https://apis.map.qq.com/ws/geocoder/v1/?location=${res.latitude},${res.longitude}&key=OB4BZ-D4W3U-B7BV2-4EMWW-6FKD3-A6B4F`,
          success: (geo) => {
            const city = (geo.data && geo.data.result && geo.data.result.ad_info
              && geo.data.result.ad_info.city) || '';
            this.setData({ locationCity: city.replace(/市$/, '') });
          },
          fail: () => {
            wx.showToast({ title: '定位失败，请手动选择', icon: 'none' });
          },
          complete: () => {
            this.setData({ locationLoading: false });
          }
        });
      },
      fail: () => {
        this.setData({ locationLoading: false });
        wx.showToast({ title: '定位失败，请手动选择', icon: 'none' });
      }
    });
  },

  // 手动选择所在地（省市区，只取市级）
  onLocationPickerChange(e) {
    const val = e.detail.value;
    this.setData({ locationCity: val[1] ? val[1].replace(/市$/, '') : val[0] });
  },

  // 籍贯：省级变化，重新加载城市列表
  onHometownProvinceChange(e) {
    const pIdx = Number(e.detail.value);
    const province = PROVINCES[pIdx];
    const cities = CITIES_BY_PROVINCE[province] || [''];
    this.setData({
      hometownProvinceIndex: pIdx,
      hometownCities: cities,
      hometownCityIndex: 0,
      hometown: [province, cities[0]]
    });
  },

  // 籍贯：市级变化
  onHometownCityChange(e) {
    const cIdx = Number(e.detail.value);
    const province = PROVINCES[this.data.hometownProvinceIndex];
    const city = this.data.hometownCities[cIdx] || '';
    this.setData({
      hometownCityIndex: cIdx,
      hometown: [province, city]
    });
  },

  onYearsChange(e) {
    this.setData({ yearsIndex: Number(e.detail.value) });
  },

  onLevelChange(e) {
    this.setData({ levelIndex: Number(e.detail.value) });
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

  save() {
    const { nickname, genderOptions, genderIndex, birthDate, phone,
            locationCity, hometown, yearsOptions, yearsIndex, levels, levelIndex } = this.data;
    if (!nickname.trim()) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const payload = {
      nickname: nickname.trim(),
      avatar: this.data.avatar,
      gender: genderOptions[genderIndex],
      birthDate,
      phone,
      locationCity,
      hometown,
      years: yearsOptions[yearsIndex],
      level: levels[levelIndex],
      canSeeGender: this.data.canSeeGender,
      canSeeBirthDate: this.data.canSeeBirthDate,
      canSeeHometown: this.data.canSeeHometown
    };
    data.saveUserProfile(payload).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: r.msg || '保存失败', icon: 'none' });
        this.setData({ submitting: false });
        return;
      }
      wx.showToast({ title: '保存成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 1500);
    }).catch(() => {
      wx.showToast({ title: '保存失败', icon: 'none' });
      this.setData({ submitting: false });
    });
  }
});
