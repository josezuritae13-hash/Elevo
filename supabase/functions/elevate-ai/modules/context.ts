// Construye el contexto académico del estudiante que recibe el modelo.
// Solo lee con el token del estudiante, así que RLS decide qué filas puede ver.

import {
  academicAverage, averageDetails, goalProgress, isGraded, recentTrend, scorePct
} from "./academic.ts";
import {
  clip, dateOnly, round2, selectRows,
  type ActionRow, type AssessmentRow, type AssignmentRow, type AttendanceRow, type GoalRow,
  type Session, type StudySessionRow, type SubjectRow, type SubmissionRow
} from "./shared.ts";

export async function buildAcademicContext(session: Session): Promise<Record<string, unknown>> {
  const userFilter = { user_id: `eq.${session.userId}` };
  const today = dateOnly(new Date());
  const thirtyDaysAgo = dateOnly(new Date(Date.now() - 30 * 864e5));
  const [
    subjects, assessments, goals, actions, studySessions, assignments, submissions, attendance
  ] = await Promise.all([
    selectRows<SubjectRow>(session, "subjects", {
      ...userFilter, select: "id,name,scale_max,category_weights", order: "created_at.desc", limit: "40"
    }),
    selectRows<AssessmentRow>(session, "assessments", {
      ...userFilter, select: "id,subject_id,name,type,score,max_score,weight,term,date,created_at",
      order: "created_at.desc", limit: "500"
    }),
    selectRows<GoalRow>(session, "goals", {
      ...userFilter, select: "id,subject_id,title,description,start_value,target_value,deadline,status",
      order: "created_at.desc", limit: "100"
    }),
    selectRows<ActionRow>(session, "actions", {
      ...userFilter, select: "goal_id,description,status,due_date", order: "created_at.desc", limit: "200"
    }),
    selectRows<StudySessionRow>(session, "study_sessions", {
      student_id: `eq.${session.userId}`, and: `(study_date.gte.${thirtyDaysAgo},study_date.lte.${today})`,
      select: "study_date,duration_minutes,subject", order: "study_date.desc", limit: "120"
    }),
    // Los deberes más recientes primero: así un historial largo no oculta los actuales.
    selectRows<AssignmentRow>(session, "class_assignments", {
      select: "id,title,due_at", order: "due_at.desc", limit: "80"
    }),
    selectRows<SubmissionRow>(session, "assignment_submissions", {
      student_id: `eq.${session.userId}`, select: "assignment_id,completed", order: "updated_at.desc", limit: "200"
    }),
    selectRows<AttendanceRow>(session, "class_attendance", {
      student_id: `eq.${session.userId}`, select: "attendance_date,status", order: "attendance_date.desc", limit: "100"
    })
  ]);

  const subjectSummaries = subjects.map(subject => {
    const scaleMax = Number(subject.scale_max);
    const subjectAssessments = assessments
      .filter(row => row.subject_id === subject.id)
      .sort((a, b) => (a.date || a.created_at).localeCompare(b.date || b.created_at));
    const details = averageDetails(subjectAssessments, scaleMax, subject.category_weights);
    const trend = recentTrend(subjectAssessments);
    const pending = subjectAssessments.filter(row => row.score === null);
    const recent = [...subjectAssessments]
      .filter(isGraded)
      .sort((a, b) => (b.date || b.created_at).localeCompare(a.date || a.created_at))
      .slice(0, 5)
      .map(row => ({
        name: clip(row.name, 80),
        type: row.type,
        term: row.term,
        date: row.date,
        score_pct: round2(scorePct(row))
      }));
    return {
      name: subject.name,
      scale_max: scaleMax,
      average: details.average === null ? null : round2(details.average),
      average_pct: details.average === null ? null : round2((details.average / scaleMax) * 100),
      average_is_provisional: details.provisional,
      categories_without_grades: details.missing_categories,
      graded_evaluations_not_in_average: details.ungrouped_graded,
      trend: trend.trend,
      trend_change_pct_points: trend.change_pct_points,
      trend_recent_avg_pct: trend.recent_avg_pct,
      trend_previous_avg_pct: trend.previous_avg_pct,
      trend_compared_evaluations: trend.compared_evaluations,
      pending_evaluations: pending
        .filter(row => !row.date || row.date >= today)
        .slice(0, 8)
        .map(row => ({ name: clip(row.name, 80), type: row.type, term: row.term, date: row.date })),
      recent_results: recent
    };
  });

  const averageRows = subjectSummaries.filter(row => row.average_pct !== null);
  const overallAverage = averageRows.length
    ? round2(averageRows.reduce((sum, row) => sum + Number(row.average_pct), 0) / averageRows.length)
    : null;
  const subjectNameById = new Map(subjects.map(subject => [subject.id, subject.name]));
  const goalSummaries = goals.map(goal => {
    const subject = subjects.find(item => item.id === goal.subject_id);
    const current = subject
      ? academicAverage(assessments.filter(row => row.subject_id === subject.id), Number(subject.scale_max), subject.category_weights)
      : null;
    const start = goal.start_value === null ? null : Number(goal.start_value);
    const target = goal.target_value === null ? null : Number(goal.target_value);
    const progress = goalProgress(current, start, target);
    const openActions = actions
      .filter(action => action.goal_id === goal.id && action.status !== "done")
      .slice(0, 5)
      .map(action => ({ description: clip(action.description, 160), due_date: action.due_date }));
    return {
      title: clip(goal.title, 120),
      subject: goal.subject_id ? subjectNameById.get(goal.subject_id) || null : null,
      status: goal.status,
      current_average: current === null ? null : round2(current),
      target_average: target,
      progress_pct: progress === null ? null : round2(progress),
      deadline: goal.deadline,
      description: clip(goal.description, 200),
      pending_actions: openActions
    };
  });

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 864e5);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 864e5);
  const minutesLastWeek = studySessions
    .filter(row => row.study_date >= dateOnly(weekAgo) && row.study_date <= today)
    .reduce((sum, row) => sum + Number(row.duration_minutes), 0);
  const minutesPreviousWeek = studySessions
    .filter(row => row.study_date >= dateOnly(twoWeeksAgo) && row.study_date < dateOnly(weekAgo))
    .reduce((sum, row) => sum + Number(row.duration_minutes), 0);
  const studyBySubject = new Map<string, number>();
  for (const session of studySessions) {
    if (session.study_date < dateOnly(twoWeeksAgo) || session.study_date > today) continue;
    studyBySubject.set(session.subject, (studyBySubject.get(session.subject) || 0) + Number(session.duration_minutes));
  }

  const submissionById = new Map(submissions.map(row => [row.assignment_id, row.completed]));
  const taskSummaries = assignments.map(assignment => ({
    title: clip(assignment.title, 120),
    due_at: assignment.due_at,
    completed: submissionById.get(assignment.id) === true,
    overdue: assignment.due_at < now.toISOString() && submissionById.get(assignment.id) !== true
  }));
  const attendanceTotals = attendance.reduce<Record<string, number>>((totals, row) => {
    totals[row.status] = (totals[row.status] || 0) + 1;
    return totals;
  }, {});
  const actionsDone = actions.filter(action => action.status === "done").length;

  return {
    today,
    overall_average_pct: overallAverage,
    subjects: subjectSummaries,
    goals: goalSummaries,
    study_habits: {
      minutes_last_7_days: minutesLastWeek,
      minutes_previous_7_days: minutesPreviousWeek,
      sessions_last_30_days: studySessions.length,
      minutes_by_subject_last_14_days: Object.fromEntries(studyBySubject),
      completed_improvement_actions: actionsDone
    },
    assignments: taskSummaries,
    attendance: {
      recorded_sessions: attendance.length,
      by_status: attendanceTotals
    }
  };
}
