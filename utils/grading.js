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

module.exports = { getGrade, getMidTermRemark, rankByTotal, ordinal };
