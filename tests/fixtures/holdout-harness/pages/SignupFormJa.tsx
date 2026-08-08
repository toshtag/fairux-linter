export function SignupFormJa() {
  return (
    <form>
      <label htmlFor="email">メールアドレス</label>
      <input id="email" type="email" name="email" />
      <label>
        <input type="checkbox" name="marketing" /> お知らせメールを受け取る
      </label>
      <button type="submit">アカウントを作成</button>
    </form>
  );
}
