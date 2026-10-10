// Full-term grade (score out of 100: CA 30 + Exam 70)
function getGrade(total) {
  if (total === null || total === undefined) return { grade: null, remark: null };
  if (total >= 75) return { grade: 'A', remark: 'Excellent' };
  if (total >= 65) return { grade: 'B', remark: 'Very good' };
  if (total >= 55) return { grade: 'C', remark: 'Good' };
  if (total >= 45) return { grade: 'D', remark: 'Fair' };
  if (total >= 40) return { grade: 'E', remark: 'Pass' };
  return { grade: 'F', remark: 'Fail' };
}

// Mid-term remark (score out of 30, pass mark = 15)
function getMidTermRemark(total) {
  if (total === null || total === undefined) return null;
  return total >= 15 ? 'Pass' : 'Fail';
}

// Ranks an array of { studentId, total } objects, highest first.
// Ties share the same position (standard competition ranking: 1,2,2,4).
function rankByTotal(entries) {
  const sorted = [...entries].sort((a, b) => b.total - a.total);
  let lastTotal = null;
  let lastRank = 0;
  return sorted.map((entry, index) => {
    if (entry.total !== lastTotal) {
      lastRank = index + 1;
      lastTotal = entry.total;
    }
    return { ...entry, position: lastRank };
  });
}

function ordinal(n) {
  if (!n) return '-';
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Automatic principal's comment, chosen from the student's overall average (%).
// Used whenever nobody has typed a manual principal comment for that student —
// a manually saved principal_comment always wins over this.
// Returns null when the student has no scores yet (nothing to comment on).
function getPrincipalComment(average, subjectCount) {
  if (!subjectCount) return null;
  if (average >= 75) return 'Outstanding performance. Keep up the excellent work and continue to set the pace for others.';
  if (average >= 65) return 'A very good result. With a little more effort, you can reach the top.';
  if (average >= 55) return 'A good result. Aim higher and stay focused next term.';
  if (average >= 45) return 'A fair result. More effort and consistent study are needed to improve.';
  if (average >= 40) return 'A weak pass. You must work much harder and seek help in the difficult subjects.';
  return 'A poor result. Serious improvement is required. Parents are advised to monitor study at home closely.';
}

module.exports = { getGrade, getMidTermRemark, rankByTotal, ordinal, getPrincipalComment };
