export function SignupForm() {
  return (
    <form>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" name="email" />
      <label>
        <input type="checkbox" name="marketing" defaultChecked /> Email me offers and product news
      </label>
      <button type="submit">Create account</button>
    </form>
  );
}
