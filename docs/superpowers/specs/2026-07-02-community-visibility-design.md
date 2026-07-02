# Community Visibility Design

Date: 2026-07-02

## Goal

Upgrade the player and coach community post publishing flow so users can choose a clearer visibility range without turning the mini program into a full friend-network product.

This design covers the first phase only. It reuses the existing follow relationship and treats mutual follows as "friends". It does not add friend requests, contact import, friend groups, or per-person allow/deny lists.

## Decisions

- Use the existing `user_follows` relationship as the only social graph.
- Define "mutual friends" as two users who follow each other.
- Keep the current location-based community value by retaining city visibility.
- Store post visibility in the existing `visibility` field.
- Treat posts without `visibility` as `public` for backward compatibility.

## Visibility Options

The publish page supports four options:

| Label | Value | Viewer Rule |
| --- | --- | --- |
| 公开可见 | `public` | Everyone can see the post. |
| 同城可见 | `region` | The author can see it. Other users can see it when their current region context matches the post region. |
| 仅互关好友可见 | `mutual` | The author can see it. Other users can see it only when they and the author follow each other. |
| 仅自己可见 | `private` | Only the author can see the post. |

## Out Of Scope

The first phase does not include:

- 添加好友
- 好友申请、通过、拒绝
- 不给谁看
- 只给谁看
- 好友分组
- 黑名单
- 通讯录导入
- 单独的好友列表页

The second phase may add "不给谁看 / 只给谁看" after the community has enough usage to justify the extra user selection flow.

## User Interface

The publish page keeps one "可见范围" row. Tapping it opens a bottom sheet instead of a simple action sheet.

The bottom sheet lists the four options in this order:

1. 公开可见
2. 同城可见
3. 仅互关好友可见
4. 仅自己可见

Each row contains an icon, title, short description, and a right-side check mark when selected. After selection, the publish page row shows the selected title and description.

Recommended descriptions:

- 公开可见: 所有球友都能看到
- 同城可见: 仅同城社区流展示
- 仅互关好友可见: 你和对方互相关注后可见
- 仅自己可见: 仅你自己可查看

## Data Model

Posts continue to use these fields:

```js
{
  visibility: 'public' | 'region' | 'mutual' | 'private',
  region: string
}
```

No new `friends` collection is needed.

The existing `user_follows` collection remains the source for follow relationships:

```js
{
  _openid: string,
  authorOpenid: string,
  createdAt: Date
}
```

Mutual follow check:

- User A follows User B when there is a row `{ _openid: A, authorOpenid: B }`.
- User B follows User A when there is a row `{ _openid: B, authorOpenid: A }`.
- A and B are mutual friends only when both rows exist.

## Permission Rules

Permission checks should run in both feed loading and post detail loading.

Rules:

1. The author can always see their own post.
2. Missing or unknown `visibility` falls back to `public`.
3. `public` is visible to everyone.
4. `region` is visible when the viewer's current region context matches the post `region`.
5. `mutual` is visible when the viewer and author mutually follow each other.
6. `private` is visible only to the author.

## Frontend Flow

On the publish page:

1. User taps the current visibility row.
2. A bottom sheet opens with four options.
3. User selects an option.
4. The page stores the selected `visibility` value.
5. On submit, the post payload includes `visibility` and the existing `region` value.

The existing title, content, image, video, topic, and location flows remain unchanged.

## Cloud Function Changes

`createPost`:

- Accept `visibility`.
- Normalize unknown values to `public`.
- Continue accepting `region`.

`getFeed`:

- Preserve existing tabs: `discover`, `follow`, `region`.
- Filter results by visibility before returning them.
- For `mutual`, query `user_follows` to verify bidirectional follow relationship.
- Keep old posts compatible by treating missing visibility as `public`.

`getPostDetail`:

- Return `post: null` when the viewer does not have permission.
- Apply the same permission rules as feed loading.

## Local Mock Changes

The local mock path should mirror cloud behavior:

- Extend local `canViewPost` to support `mutual`.
- Reuse local `KEY_FOLLOWS` data.
- Treat missing `visibility` as `public`.

## Testing

Manual test cases:

1. Publish a public post and confirm other users can see it.
2. Publish a city post and confirm it appears in the matching city feed.
3. Publish a mutual-only post and confirm only mutual followers can see it.
4. Confirm one-way followers cannot see a mutual-only post.
5. Publish a private post and confirm only the author can see it.
6. Open a restricted post detail directly and confirm unauthorized users see the "not found/deleted" state.
7. Confirm old posts without `visibility` still appear as public posts.

Static checks:

- Run JavaScript syntax checks on changed page files and cloud functions.
- Verify the publish page still submits image and video posts.

## Risks

- Cloud feed filtering may require extra `user_follows` queries for mutual-only posts. Keep the first implementation simple and page-limited.
- Region visibility depends on the current city resolution. If location permission is denied, region-only discovery may remain limited.
- "仅互关好友可见" can be misunderstood as a formal friend system. The UI copy should mention "互相关注" to keep expectations clear.

## Future Phase

If community activity grows, add a second-phase design for:

- 不给谁看
- 只给谁看
- Selecting users from mutual follows
- Per-post allow and deny lists

That phase should still avoid building a full friend request system unless the product direction changes toward private social networking.
