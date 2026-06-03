# Veloxis · Billiards Training Data Management System (Milestones 1-5)

A WeChat Mini Program for managing billiards training data. It already ships the **first-generation member side** (GitHub-style check-in heatmap + training details), the **coach side** (profile verification / bookable time slots / pricing / view bound students' data / lesson booking management), the **shop side** (manage coaches / member training statistics), the **billiards community** (video & image posts, feed, likes, comments, follows — Xiaohongshu-style), and **match social** (find a partner / book a coach / book a table). It also includes a **login identity selector**, a **custom bottom tab bar** that renders dynamically by role, and a **dark theme**. Built on WeChat Cloud Development; when no cloud environment is configured it automatically falls back to built-in mock data, so it can be demoed directly in the DevTools.

Brand color "Veloxis Blue": `#067EF9` (RGB 6,126,249).

## Feature Overview

### Login & UI Framework

- Login identity selector: member / coach / shop entry points; after login, users land on the workspace matching their role
- Custom bottom tab bar (`custom-tab-bar`): renders tabs dynamically per role (Player: Check-in / Community / Match / Records / Profile; Coach: Check-in / Community / Records / My Students / Profile), with line-style outline icons and active highlight (Veloxis Blue)
- Dark theme: unified switching via a global `themeBehavior`; nav bar, cards, and icons adapt to the theme

### Milestone 1 · Member Side

- Training check-in heatmap: 53-week × 7-day grid, GitHub contributions style
  - A cell lights up when daily training count ≥ 1
  - Three color depths by total daily duration: 0-3h (light) / 3-8h (medium) / 8h+ (dark), all in shades of Veloxis Blue
- Tap a cell: a tooltip on top shows "today's total training duration", and the details panel below lists each record for that day (venue + duration); multiple venues on the same day appear on separate rows
- Training record entry; top summary: total check-in days / total duration / consecutive check-in days

### Milestone 2 · Coach Side

- Identity switching: the "Profile" page can switch between member / coach roles; **members cannot see the coach workspace** (UI isolation)
- Coach profile: nickname, playing years, coaching years, personal photo, certificates (multiple images), and a one-line intro
- Bookable time slots (by weekday + start/end time, add/remove) and pricing (X yuan/minute)
- Coach-student binding: after a coach binds a member, they can open "Student Training Data" to view that member's heatmap and details (read-only);
  the cloud function enforces **authorization checks** based on `coach_member_links` — viewing is denied without a binding (members also cannot reverse-view the coach UI)

### Milestone 3 · Shop Side

- Three-role switching (member / coach / shop), with each workspace fully isolated
- Shop profile: shop name + affiliated billiards hall; workspace overview (managed coach count / member count / total training duration)
- Coach roster: centrally manage the shop's coaches (add / remove / view coach profile)
- Member training statistics: by the shop's affiliated hall, count each member's **check-in days** and **training duration** (distinct dates for days, accumulated minutes for duration), sorted by duration descending

### Milestone 4 · Billiards Community (Xiaohongshu-style)

- Feed: two-column waterfall layout, cover images with adaptive height, video posts carry a play badge; supports pull-to-refresh
- Posting: image (up to 9 images) / video forms, with title and body; triggered by the floating "+" button at the bottom
- Post detail: image carousel (tap for full-screen preview) / video playback, author and body, **like** toggle, **comment** list and instant posting
- Data: `posts` / `post_likes` / `post_comments` collections; likes deduped per user, comments and post counts kept in sync
- Follow: follow / unfollow a post's author (coach); `user_follows` collection deduped per user

### Milestone 5 · Match Social

- The Match page has three sections: **Find a Partner / Book a Coach / Book a Table**
- Find a Partner: publish a match invitation (venue, time, game type, note); other players can **sign up to join**, with sign-ups deduped per user and join counts kept in sync
- Book a Coach: pick a date (next 7 days) and time slot to book a coaching lesson, priced by the coach's `yuan/minute`
- Book a Table: book a table at a specific hall
- My Matches: view "invitations I started / ones I joined / my bookings" and cancel them
- Coach lesson management (`pages/coach/bookings`): coaches view bookings initiated by students

## Directory Structure

```
veloxis-cuetrace/
├── miniprogram/
│   ├── app.js / app.json / app.wxss
│   ├── custom-tab-bar/         # Custom bottom tab bar (dynamic by role + icons)
│   ├── components/heatmap/     # Heatmap component (reused by member/coach pages)
│   ├── pages/login/            # Login identity selector (member / coach / shop)
│   ├── pages/checkin/          # Member check-in heatmap + details (home)
│   ├── pages/training/         # Add training record
│   ├── pages/profile/          # Profile (role switch / coach entry)
│   ├── pages/coach/profile/    # Edit coach profile
│   ├── pages/coach/members/    # My students (bind / list)
│   ├── pages/coach/member/     # View a student's training data (read-only)
│   ├── pages/coach/bookings/   # Coach lesson management (view student bookings)
│   ├── pages/shop/dashboard/   # Shop workspace (shop settings / overview / entries)
│   ├── pages/shop/coaches/     # Coach roster (add / remove)
│   ├── pages/shop/members/     # Member training statistics
│   ├── pages/community/index   # Community feed (two-column waterfall)
│   ├── pages/community/detail  # Post detail (image/video + likes + comments + follow)
│   ├── pages/community/post    # Publish a post (image / video)
│   ├── pages/match/index       # Match (find partner / book coach / book table)
│   ├── pages/match/post        # Publish a match invitation
│   ├── pages/match/mine        # My matches (started / joined / bookings)
│   ├── services/data.js        # Data service layer (auto switch cloud / mock)
│   └── utils/                  # date / color / mock / themeBehavior
├── cloudfunctions/             # login / getHalls / getHeatmap / getDayDetail / addTraining
│                               # + saveCoachProfile / getCoachProfile / linkMember / getMyMembers
│                               # + saveShopProfile / getShopProfile / getShopCoaches
│                               # + getLinkableCoaches / addShopCoach / removeShopCoach / getShopMembers
│                               # + createPost / getFeed / getPostDetail / toggleLike / addComment
│                               # + getFollows / toggleFollow / getCoaches
│                               # + getMatchPosts / createMatchPost / joinMatch / cancelJoin / cancelMatch
│                               # + getMyMatches / getMyJoins
│                               # + createBooking / cancelBooking / getCoachBookings / getMyBookings
├── project.config.json
└── README.md
```

## How to Run

### Option A: Local demo (no cloud environment, works out of the box)

1. In WeChat DevTools, choose "Import Project" and select this directory.
2. The AppID can be a "test account" or your own Mini Program AppID (`project.config.json` defaults to `touristappid`).
3. Compile and run directly. When `cloudEnv` in `miniprogram/app.js` is empty, the system uses built-in mock data (about 300 days of demo training records are seeded on first launch).
4. On the "Profile" page you can tap "Reset Demo Data" to regenerate it.

### Option B: Connect WeChat Cloud Development

1. Enable "Cloud Development" in DevTools and obtain an environment ID.
2. Edit `miniprogram/app.js`:

```js
globalData: {
  cloudReady: false,
  cloudEnv: 'your-cloud-env-id',
  ...
}
```

3. Right-click each function directory under `cloudfunctions/` → "Upload and Deploy: Install Dependencies in Cloud".
4. Create these collections in the cloud database: `users`, `halls`, `training_sessions`, `coaches`, `coach_member_links`, `shops`, `shop_coach_links`, `posts`, `post_likes`, `post_comments`, `user_follows`, `matches`, `match_joins`, `bookings`; populate `halls` with some billiards halls and `training_sessions` with test data (or write it in-app via "Record Training").

> Coach binding a member / shop adding a coach: in mock mode you pick from demo candidates; in cloud mode you bind by entering the other party's code (openid).

## Data Model (Cloud Database Collections)

- `users`: `_openid`, `role`(member/coach/shop), `nickname`, `avatar`
- `halls`: `name`, `address`
- `training_sessions`: `_openid`, `hallId`, `hallName`, `date`(YYYY-MM-DD), `startTime`, `durationMinutes`
- `coaches`: `_openid`, `nickname`, `playYears`, `coachYears`, `avatar`, `certificates`(image array), `intro`, `availability`(time-slot array), `pricePerMinute`
- `coach_member_links`: `coachOpenid`, `memberOpenid`, `status`, `createdAt`
- `shops`: `_openid`, `name`, `hallId`, `hallName`
- `shop_coach_links`: `shopOpenid`, `coachOpenid`, `status`, `createdAt`
- `posts`: `_openid`, `authorName`, `authorAvatar`, `type`(image/video), `title`, `content`, `images`(array), `video`, `cover`, `likeCount`, `commentCount`, `createdAt`
- `post_likes`: `_openid`, `postId`, `createdAt`
- `post_comments`: `_openid`, `postId`, `content`, `authorName`, `authorAvatar`, `createdAt`
- `user_follows`: `_openid`, `authorOpenid`, `createdAt` (follow relations, deduped per user)
- `matches`: `_openid`, `authorName`, `hallId`, `hallName`, `datetime`, `gameType`, `note`, `joinCount`, `status`(open), `createdAt`
- `match_joins`: `_openid`, `matchId`, `authorName`, `hallName`, `datetime`, `gameType`, `createdAt` (sign-up records)
- `bookings`: `_openid`, `bookerName`, `type`(coach/table), `targetId`, `targetName`, `hallName`, `datetime`, `note`, `price`, `status`(pending), `createdAt`

Color grading rules (`utils/color.js` and `cloudfunctions/getHeatmap` stay consistent):

| Level | Daily total duration | Color |
| --- | --- | --- |
| 0 | No training | `#EBEDF0` |
| 1 | 0–3 hours | `rgba(6,126,249,0.35)` |
| 2 | 3–8 hours | `rgba(6,126,249,0.65)` |
| 3 | Over 8 hours | `rgba(6,126,249,1)` |

## Roadmap

- Milestone 1: Member-side check-in visualization (done)
- Milestone 2: Coach side (profile/certification, bookable slots, pricing, view bound members' data) (done)
- Milestone 3: Shop side (coach roster, member check-in and duration statistics) (done)
- Milestone 4: Billiards community (video/image posts, feed, likes, comments, follows) (done)
- Milestone 5: Match social (find partner / book coach / book table, sign-ups and bookings, coach lesson management) (done)
- Milestone 6 (second generation): Camera-based solo training / 1v1 PK data capture and analysis
